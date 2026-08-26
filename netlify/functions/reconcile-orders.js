// Read-only reconciliation worker.
// It never creates or retries an order; it only updates intent state from broker evidence.

const https = require('https');
const {
  initializeBlobContext,
  listIntents,
  transitionIntent,
  isExpired,
} = require('../lib/order-intent-store');
const { fetchRawOrders } = require('../lib/settrade-read');
const { normalizeBrokerOrderState } = require('../lib/broker-order-status');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function postTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return Promise.resolve(false);
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: String(text).slice(0, 4096) });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

function brokerStatusToIntentStatus(status) {
  return normalizeBrokerOrderState(status);
}

function findUniqueUncertainOrder(intent, brokerOrders, claimedOrderIds = new Set()) {
  const submittedAt = new Date(intent.broker?.submittedAt || 0).getTime();
  if (!Number.isFinite(submittedAt) || submittedAt <= 0) return null;
  const requestPrice = Number(intent.broker?.request?.price || intent.proposedPrice || 0);

  const candidates = (Array.isArray(brokerOrders) ? brokerOrders : []).filter((order) => {
    const entryAt = new Date(order.entryTime || 0).getTime();
    const timeDistance = Math.abs(entryAt - submittedAt);
    return order.id &&
      !claimedOrderIds.has(String(order.id)) &&
      String(order.symbol || '').toUpperCase() === intent.symbol &&
      String(order.side || '').toUpperCase() === intent.side &&
      Number(order.quantity) === Number(intent.quantity) &&
      Math.abs(Number(order.price || 0) - requestPrice) <= 0.0001 &&
      Number.isFinite(entryAt) &&
      timeDistance <= 5 * 60 * 1000;
  });

  return candidates.length === 1 ? candidates[0] : null;
}

exports.handler = async (event = {}) => {
  await initializeBlobContext(event);
  const intents = await listIntents(event, { limit: 1000 });
  const changes = [];
  const errors = [];

  for (const intent of intents.filter((item) => item.status === 'PENDING_APPROVAL')) {
    if (!isExpired(intent)) continue;
    try {
      const expired = await transitionIntent(intent.id, 'PENDING_APPROVAL', 'EXPIRED', {}, {
        event,
        actor: 'reconciliation-worker',
        note: 'Intent TTL elapsed',
      });
      changes.push({ id: expired.id, symbol: expired.symbol, from: 'PENDING_APPROVAL', to: 'EXPIRED' });
    } catch (error) {
      errors.push({ id: intent.id, error: error.message });
    }
  }

  const activeStatuses = new Set(['SUBMITTING', 'SUBMITTED', 'RECONCILE_PENDING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'EXECUTION_UNCERTAIN']);
  const active = intents.filter((item) => activeStatuses.has(item.status) &&
    (item.broker?.orderId || ['SUBMITTING', 'EXECUTION_UNCERTAIN'].includes(item.status)));

  let brokerOrders = [];
  if (active.length > 0) {
    try {
      brokerOrders = await fetchRawOrders();
    } catch (error) {
      errors.push({ id: 'broker-read', error: error.message });
    }
  }

  const claimedOrderIds = new Set(intents.map((item) => item.broker?.orderId).filter(Boolean).map(String));

  for (const intent of active) {
    const matched = intent.broker?.orderId
      ? brokerOrders.find((order) => String(order.id || '') === String(intent.broker.orderId))
      : findUniqueUncertainOrder(intent, brokerOrders, claimedOrderIds);
    if (!matched) {
      const submittedAt = new Date(intent.broker?.submittedAt || 0).getTime();
      const oldEnough = Number.isFinite(submittedAt) && Date.now() - submittedAt > 15 * 60 * 1000;
      if (oldEnough && intent.status !== 'EXECUTION_UNCERTAIN') {
        try {
          const uncertain = await transitionIntent(intent.id, intent.status, 'EXECUTION_UNCERTAIN', {
            lastError: 'BROKER_ORDER_NOT_FOUND_AFTER_15_MINUTES',
          }, {
            event,
            actor: 'reconciliation-worker',
            note: 'Never auto-resubmit an uncertain order',
          });
          changes.push({ id: uncertain.id, symbol: uncertain.symbol, from: intent.status, to: uncertain.status });
        } catch (error) {
          errors.push({ id: intent.id, error: error.message });
        }
      }
      continue;
    }

    const nextStatus = normalizeBrokerOrderState(matched);
    if (nextStatus === intent.status) continue;

    try {
      const updated = await transitionIntent(intent.id, intent.status, nextStatus, {
        broker: {
          ...intent.broker,
          orderId: intent.broker?.orderId || matched.id,
          reconciledAt: new Date().toISOString(),
          brokerStatus: matched.status,
          matchedQuantity: matched.matchedQuantity,
        },
      }, { event, actor: 'reconciliation-worker' });
      changes.push({ id: updated.id, symbol: updated.symbol, from: intent.status, to: updated.status });
    } catch (error) {
      errors.push({ id: intent.id, error: error.message });
    }
  }

  if (changes.length > 0 || errors.length > 0) {
    const lines = [
      '🔄 ORDER RECONCILIATION',
      ...changes.slice(0, 20).map((item) => `• ${item.symbol} [${item.id}] ${item.from} → ${item.to}`),
    ];
    if (errors.length > 0) lines.push(...errors.slice(0, 10).map((item) => `• ERROR ${item.id}: ${item.error}`));
    await postTelegram(lines.join('\n'));
  }

  return {
    statusCode: errors.length > 0 ? 207 : 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: errors.length === 0, changes, errors }),
  };
};

module.exports._test = { brokerStatusToIntentStatus, findUniqueUncertainOrder };
