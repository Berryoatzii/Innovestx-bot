const crypto = require('crypto');
const {
  getIntent,
  listIntents,
  transitionIntent,
  isExpired,
} = require('./order-intent-store');
const { reserveOperationalPilotAttempt } = require('./operational-pilot-lock');

const TERMINAL_REPORTS = new Set([
  'RECONCILE_PENDING',
  'ACKNOWLEDGED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED_BY_BROKER',
  'EXPIRED_BY_BROKER',
  'EXECUTION_UNCERTAIN',
]);

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function workerAuthorized(headers = {}) {
  const expected = String(process.env.PRIVATE_WORKER_TOKEN || '');
  const match = Object.entries(headers).find(([key]) => String(key).toLowerCase() === 'x-private-worker-token');
  return Boolean(expected && match && safeEqual(match[1], expected));
}

function normalizeOrder(order = {}) {
  return {
    symbol: String(order.symbol || order.ticker || '').toUpperCase().trim(),
    side: String(order.side || '').toUpperCase().trim(),
    quantity: Math.floor(Number(order.quantity || order.qty || 0)),
    price: Number(order.price || 0),
  };
}

function workerPayload(intent, claimId) {
  return {
    intentId: intent.id,
    claimId,
    symbol: intent.symbol,
    side: intent.side,
    quantity: intent.quantity,
    price: intent.proposedPrice,
    orderStyle: intent.orderStyle,
    expiresAt: intent.expiresAt,
    portfolioBucket: intent.portfolioBucket,
    decisionAuthority: intent.decisionAuthority,
    portfolioQty: intent.portfolioQty,
    boardLot: intent.boardLot,
    instrumentType: intent.instrumentType,
    exitMode: intent.exitMode,
    candidateId: intent.candidateId,
    strategyVersion: intent.strategyVersion,
  };
}

function canonicalWorkerPayload(payload = {}) {
  return [
    String(payload.intentId || '').toLowerCase(),
    String(payload.claimId || '').toLowerCase(),
    String(payload.symbol || '').toUpperCase(),
    String(payload.side || '').toUpperCase(),
    String(Math.floor(Number(payload.quantity || 0))),
    Number(payload.price || 0).toFixed(4),
    String(payload.orderStyle || '').toUpperCase(),
    String(payload.expiresAt || ''),
    String(Math.floor(Number(payload.portfolioQty || 0))),
    String(Math.floor(Number(payload.boardLot || 0))),
    String(payload.instrumentType || '').toUpperCase(),
    String(payload.exitMode || '').toUpperCase(),
    String(payload.candidateId || ''),
    String(payload.strategyVersion || ''),
  ].join('|');
}

function signWorkerPayload(payload) {
  const secret = String(process.env.ORDER_INTENT_GATE_SECRET || '');
  if (!secret) throw new Error('ORDER_INTENT_GATE_SECRET_NOT_CONFIGURED');
  return crypto.createHmac('sha256', secret).update(canonicalWorkerPayload(payload)).digest('hex');
}

function assertClaim(intent, claimId) {
  if (!intent || intent.status !== 'WORKER_CLAIMED') throw new Error('INTENT_NOT_WORKER_CLAIMED');
  if (!safeEqual(intent.worker?.claimId, claimId)) throw new Error('WORKER_CLAIM_MISMATCH');
}

function assertExactOrder(intent, order) {
  const normalized = normalizeOrder(order);
  if (
    normalized.symbol !== intent.symbol ||
    normalized.side !== intent.side ||
    normalized.quantity !== Number(intent.quantity) ||
    Math.abs(normalized.price - Number(intent.proposedPrice)) > 0.0001
  ) throw new Error('WORKER_ORDER_DOES_NOT_MATCH_APPROVED_INTENT');
  if (String(intent.orderStyle || '').toUpperCase() !== 'RESTING_LIMIT') {
    throw new Error('PRIVATE_WORKER_REQUIRES_RESTING_LIMIT');
  }
  return normalized;
}

async function queueApprovedIntent(intentId, approver, event) {
  const intent = await getIntent(intentId, event, { requireStrong: true });
  if (!intent) throw new Error('INTENT_NOT_FOUND');
  if (intent.status !== 'PENDING_APPROVAL') throw new Error(`INTENT_NOT_PENDING:${intent.status}`);
  if (isExpired(intent)) {
    return transitionIntent(intentId, 'PENDING_APPROVAL', 'EXPIRED', {}, {
      event, actor: approver, note: 'Approval attempted after expiry',
    });
  }
  if (String(intent.orderStyle || '').toUpperCase() !== 'RESTING_LIMIT') {
    throw new Error('PRIVATE_WORKER_REQUIRES_RESTING_LIMIT');
  }
  return transitionIntent(intentId, 'PENDING_APPROVAL', 'APPROVED_QUEUED', {
    approval: { approvedAt: new Date().toISOString(), approver },
  }, { event, actor: approver, note: 'Queued for outbound private-worker claim' });
}

async function claimNextIntent(workerId, event) {
  if (!/^[A-Za-z0-9._:-]{3,80}$/.test(String(workerId || ''))) throw new Error('INVALID_WORKER_ID');
  const queued = await listIntents(event, { status: 'APPROVED_QUEUED', limit: 100, consistency: 'strong' });
  for (const candidate of queued.reverse()) {
    if (isExpired(candidate)) {
      try {
        await transitionIntent(candidate.id, 'APPROVED_QUEUED', 'EXPIRED', {}, {
          event, actor: `worker:${workerId}`, note: 'Expired before worker claim',
        });
      } catch {}
      continue;
    }
    const claimId = crypto.randomBytes(16).toString('hex');
    try {
      const claimed = await transitionIntent(candidate.id, 'APPROVED_QUEUED', 'WORKER_CLAIMED', {
        worker: { workerId, claimId, claimedAt: new Date().toISOString() },
      }, { event, actor: `worker:${workerId}`, note: 'Atomic outbound worker claim' });
      const payload = workerPayload(claimed, claimId);
      return { payload, signature: signWorkerPayload(payload) };
    } catch (error) {
      if (!String(error.message).includes('CONFLICT')) throw error;
    }
  }
  return null;
}

async function markAttempt(input, workerId, event) {
  const intent = await getIntent(input.intentId, event, { requireStrong: true });
  assertClaim(intent, input.claimId);
  const order = assertExactOrder(intent, input.order);
  if (process.env.OPERATIONAL_PILOT_MODE === 'true') {
    // This permanent strong-consistency lock is reserved before the cloud
    // attempt marker and before the private worker can call the broker.
    await reserveOperationalPilotAttempt(intent, event);
  }
  return transitionIntent(intent.id, 'WORKER_CLAIMED', 'SUBMITTING', {
    broker: {
      attemptedAt: new Date().toISOString(),
      request: order,
      submittedPrice: order.price,
      submittedValue: Number((order.quantity * order.price).toFixed(2)),
      orderStyle: 'RESTING_LIMIT',
    },
  }, {
    event,
    actor: `worker:${workerId}`,
    note: 'Durable cloud attempt marker written before local broker POST; never auto-resubmit',
  });
}

async function reportPrecheckFailure(input, workerId, event) {
  const intent = await getIntent(input.intentId, event, { requireStrong: true });
  assertClaim(intent, input.claimId);
  const reason = String(input.reason || 'PRIVATE_WORKER_PRECHECK_FAILED').slice(0, 300);
  return transitionIntent(intent.id, 'WORKER_CLAIMED', 'FAILED_PRECHECK', { lastError: reason }, {
    event, actor: `worker:${workerId}`, note: reason,
  });
}

async function reportSubmission(input, workerId, event) {
  const intent = await getIntent(input.intentId, event, { requireStrong: true });
  if (!intent || intent.status !== 'SUBMITTING') throw new Error('INTENT_NOT_SUBMITTING');
  if (!safeEqual(intent.worker?.claimId, input.claimId)) throw new Error('WORKER_CLAIM_MISMATCH');
  const orderId = String(input.orderId || '').trim();
  if (input.outcome === 'SUBMITTED') {
    if (!orderId) throw new Error('BROKER_ORDER_ID_REQUIRED');
    return transitionIntent(intent.id, 'SUBMITTING', 'SUBMITTED', {
      broker: { ...intent.broker, orderId, responseStatus: Number(input.responseStatus || 200) },
    }, { event, actor: `worker:${workerId}`, note: 'Broker acceptance reported by private worker' });
  }
  if (input.outcome === 'REJECTED_BY_BROKER') {
    const reason = String(input.reason || 'BROKER_REJECTED_ORDER').slice(0, 300);
    return transitionIntent(intent.id, 'SUBMITTING', 'REJECTED_BY_BROKER', { lastError: reason }, {
      event, actor: `worker:${workerId}`, note: reason,
    });
  }
  if (input.outcome !== 'EXECUTION_UNCERTAIN') throw new Error('INVALID_SUBMISSION_OUTCOME');
  const reason = String(input.reason || 'PRIVATE_WORKER_EXECUTION_UNCERTAIN').slice(0, 300);
  return transitionIntent(intent.id, 'SUBMITTING', 'EXECUTION_UNCERTAIN', { lastError: reason }, {
    event, actor: `worker:${workerId}`, note: reason,
  });
}

async function reportReconciliation(input, workerId, event) {
  const intent = await getIntent(input.intentId, event, { requireStrong: true });
  if (!intent) throw new Error('INTENT_NOT_FOUND');
  if (!safeEqual(intent.worker?.claimId, input.claimId)) throw new Error('WORKER_CLAIM_MISMATCH');
  const outcome = String(input.outcome || '').toUpperCase();
  if (!TERMINAL_REPORTS.has(outcome)) throw new Error('INVALID_RECONCILIATION_OUTCOME');
  if (intent.status === outcome) return intent;
  const allowedFrom = ['SUBMITTED', 'ACKNOWLEDGED', 'RECONCILE_PENDING', 'PARTIALLY_FILLED', 'EXECUTION_UNCERTAIN'];
  return transitionIntent(intent.id, allowedFrom, outcome, {
    broker: {
      ...intent.broker,
      reconciledAt: new Date().toISOString(),
      brokerStatus: String(input.brokerStatus || outcome).slice(0, 80),
      matchedQuantity: Math.max(0, Math.floor(Number(input.matchedQuantity || 0))),
    },
  }, { event, actor: `worker:${workerId}`, note: 'Private-worker broker reconciliation' });
}

async function nextReconciliation(workerId, event) {
  if (!/^[A-Za-z0-9._:-]{3,80}$/.test(String(workerId || ''))) throw new Error('INVALID_WORKER_ID');
  const statuses = new Set([
    'SUBMITTED', 'ACKNOWLEDGED', 'RECONCILE_PENDING', 'PARTIALLY_FILLED', 'EXECUTION_UNCERTAIN',
  ]);
  const intents = await listIntents(event, { limit: 1000, consistency: 'strong' });
  const pending = intents
    .filter((item) => statuses.has(item.status) && item.worker?.workerId === workerId)
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
  if (!pending) return null;
  return {
    intentId: pending.id,
    claimId: pending.worker.claimId,
    status: pending.status,
    orderId: pending.broker?.orderId || null,
  };
}

module.exports = {
  workerAuthorized,
  queueApprovedIntent,
  claimNextIntent,
  markAttempt,
  reportPrecheckFailure,
  reportSubmission,
  reportReconciliation,
  nextReconciliation,
  _test: {
    safeEqual,
    normalizeOrder,
    workerPayload,
    canonicalWorkerPayload,
    signWorkerPayload,
    assertExactOrder,
  },
};
