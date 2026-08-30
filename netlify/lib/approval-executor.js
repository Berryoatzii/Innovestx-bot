const crypto = require('crypto');
const { handler: secureInvxHandler } = require('../functions/invx');
const { fetchRawOrders } = require('./settrade-read');
const { isContinuousSession } = require('./market-calendar');
const { normalizeBrokerOrderState, isBrokerOrderTerminal } = require('./broker-order-status');
const { reserveOperationalPilotAttempt } = require('./operational-pilot-lock');
const { queueApprovedIntent } = require('./private-worker-queue');
const { loadReleaseConfig } = require('./release-config');
const { isCandidateDrFullExit } = require('./candidate-dr-controls');
const releaseConfig = loadReleaseConfig();
const {
  evaluateOperationalPilotEvidence,
  evaluateReleaseEvidence,
} = require('./real-money-release');
const {
  getIntent,
  transitionIntent,
  getDailyExecutionStats,
  isExpired,
} = require('./order-intent-store');

const ALLOWED_DECISION_AUTHORITIES = new Set([
  'DETERMINISTIC_RULES_PLUS_HUMAN_APPROVAL',
  'HUMAN_OPERATOR_LIMIT_DRAFT_PLUS_RISK_APPROVAL',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name) {
  return process.env[name] === 'true';
}

function approvalAvailability(options = {}) {
  const executionTopology = String(process.env.EXECUTION_TOPOLOGY || 'DIRECT_GATEWAY').toUpperCase();
  const directRequired = [
    'ADMIN_TOKEN',
    'EXECUTE_CONFIRMATION',
    'ORDER_INTENT_GATE_SECRET',
    'BROKER_GATEWAY_URL',
    'BROKER_GATEWAY_TOKEN',
    'BROKER_GATEWAY_ENVIRONMENT',
  ];
  const workerRequired = [
    'PRIVATE_WORKER_TOKEN',
    'ORDER_INTENT_GATE_SECRET',
  ];
  const required = executionTopology === 'PRIVATE_WORKER_QUEUE' ? workerRequired : directRequired;
  const missing = required.filter((name) => !process.env[name]);
  const maxOrderValue = numberEnv('MAX_LIVE_ORDER_VALUE', 0);
  const maxDailyNotional = numberEnv('MAX_DAILY_APPROVED_NOTIONAL', 0);
  const gatewayEnvironment = String(process.env.BROKER_GATEWAY_ENVIRONMENT || '').toLowerCase();
  const gatewayUrl = String(process.env.BROKER_GATEWAY_URL || '');
  const cloudRuntime = process.env.NETLIFY === 'true' || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localGateway = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/|$)/i.test(gatewayUrl);
  const gatewayTopologyAllowed = !(cloudRuntime && localGateway);
  const productionGateway = executionTopology === 'PRIVATE_WORKER_QUEUE' || gatewayEnvironment === 'prod';
  const operationalPilotMode = boolEnv('OPERATIONAL_PILOT_MODE');
  const manifest = options.releaseManifest || releaseConfig;
  const releaseEvidence = operationalPilotMode
    ? evaluateOperationalPilotEvidence(manifest)
    : evaluateReleaseEvidence(manifest);

  return {
    ready:
      boolEnv('LIVE_TRADING_ENABLED') &&
      boolEnv('HUMAN_APPROVAL_LIVE_ENABLED') &&
      missing.length === 0 &&
      productionGateway &&
      gatewayTopologyAllowed &&
      maxOrderValue > 0 &&
      maxDailyNotional > 0 &&
      releaseEvidence.passed,
    liveTradingEnabled: boolEnv('LIVE_TRADING_ENABLED'),
    humanApprovalEnabled: boolEnv('HUMAN_APPROVAL_LIVE_ENABLED'),
    missing,
    gatewayEnvironment,
    productionGateway,
    gatewayTopologyAllowed,
    maxOrderValue,
    maxDailyNotional,
    operationalPilotMode,
    executionTopology,
    releaseEvidencePassed: releaseEvidence.passed,
    releaseBlockers: releaseEvidence.blockers,
  };
}

async function approveIntent(intentId, approver, event) {
  const availability = approvalAvailability();
  if (!availability.ready) {
    const intent = await getIntent(intentId, event);
    return { executed: false, status: 'LIVE_LOCKED', availability, intent };
  }
  if (availability.executionTopology === 'PRIVATE_WORKER_QUEUE') {
    const intent = await queueApprovedIntent(intentId, approver, event);
    return { executed: false, queued: true, status: intent.status, intent };
  }
  return executeApprovedIntent(intentId, approver, event);
}

function bkkClock(date = new Date()) {
  const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    date: shifted.toISOString().slice(0, 10),
  };
}

function isThaiContinuousSession(date = new Date()) {
  return isContinuousSession(date).open;
}

function normalizeSignedOrderBody(body = {}) {
  const rawSide = String(body.side || '').toUpperCase();
  const side = rawSide.startsWith('B') ? 'BUY' : rawSide.startsWith('S') ? 'SELL' : rawSide;
  return {
    symbol: String(body.ticker || body.symbol || '').toUpperCase().trim(),
    side,
    quantity: Math.floor(Number(body.quantity || body.qty || body.volume || 0)),
    price: Number(body.price || 0),
  };
}

function signaturePayload(intentId, orderBody = {}) {
  const normalized = normalizeSignedOrderBody(orderBody);
  return [
    String(intentId || '').toLowerCase(),
    normalized.symbol,
    normalized.side,
    String(normalized.quantity),
    Number(normalized.price || 0).toFixed(4),
  ].join('|');
}

function intentGateSignature(intentId, orderBody = {}) {
  const secret = process.env.ORDER_INTENT_GATE_SECRET || '';
  if (!secret) throw new Error('ORDER_INTENT_GATE_SECRET_NOT_CONFIGURED');
  return crypto.createHmac('sha256', secret)
    .update(signaturePayload(intentId, orderBody))
    .digest('hex');
}

async function callInvx({ action, method = 'GET', body = null, query = {}, intentId = null, event = null }) {
  const headers = {};
  if (['getData', 'ping', 'debug', 'order', 'cancel'].includes(action)) {
    headers['x-admin-token'] = process.env.ADMIN_TOKEN || '';
  }
  if (action === 'order') {
    headers['x-execute-confirmation'] = process.env.EXECUTE_CONFIRMATION || '';
    headers['x-order-intent-id'] = intentId || '';
    headers['x-order-intent-signature'] = intentGateSignature(intentId, body || {});
  }

  const response = await secureInvxHandler({
    httpMethod: method,
    headers,
    queryStringParameters: { action, ...query },
    body: body ? JSON.stringify(body) : '',
    requestContext: event?.requestContext,
  });

  let payload = {};
  try { payload = JSON.parse(response.body || '{}'); }
  catch { payload = { raw: response.body || '' }; }
  return { statusCode: response.statusCode || 500, payload };
}

function normalizeOrderSide(side) {
  const value = String(side || '').toUpperCase();
  if (value === 'B' || value === 'BUY') return 'BUY';
  if (value === 'S' || value === 'SELL') return 'SELL';
  return value;
}

function hasDuplicateOpenOrder(orders, intent) {
  return (Array.isArray(orders) ? orders : []).some((order) => {
    return String(order.symbol || order.sym || '').toUpperCase() === intent.symbol &&
      normalizeOrderSide(order.side) === intent.side &&
      !isBrokerOrderTerminal(order);
  });
}

function validateMarketData(intent, quote) {
  const last = Number(quote.last || 0);
  const bid = Number(quote.bid || 0);
  const ask = Number(quote.ask || 0);
  if (last <= 0 || bid <= 0 || ask <= 0) throw new Error('QUOTE_NOT_TRADEABLE');
  if (ask < bid) throw new Error('CROSSED_MARKET');

  const midpoint = (bid + ask) / 2;
  const spreadPct = midpoint > 0 ? (ask - bid) / midpoint : 1;
  const maxSpreadPct = numberEnv('MAX_SPREAD_PCT', 0.03);
  if (spreadPct > maxSpreadPct) throw new Error(`SPREAD_TOO_WIDE:${spreadPct.toFixed(4)}`);

  const orderStyle = String(intent.orderStyle || 'MARKETABLE_LIMIT').toUpperCase();
  let executionPrice;
  let driftPct;

  if (orderStyle === 'RESTING_LIMIT') {
    executionPrice = Number(intent.proposedPrice || 0);
    if (executionPrice <= 0) throw new Error('RESTING_LIMIT_PRICE_INVALID');
    driftPct = Math.abs(executionPrice - last) / last;
    const maxDistancePct = numberEnv('MAX_RESTING_LIMIT_DISTANCE_PCT', 0.15);
    if (driftPct > maxDistancePct) {
      throw new Error(`RESTING_LIMIT_TOO_FAR:${driftPct.toFixed(4)}`);
    }
  } else {
    executionPrice = intent.side === 'SELL' ? bid : ask;
    driftPct = Math.abs(executionPrice - intent.proposedPrice) / intent.proposedPrice;
    const maxDriftPct = numberEnv('MAX_PRICE_DRIFT_PCT', 0.02);
    if (driftPct > maxDriftPct) throw new Error(`PRICE_DRIFT_TOO_HIGH:${driftPct.toFixed(4)}`);
  }

  return { last, bid, ask, spreadPct, driftPct, executionPrice, orderStyle };
}

function portfolioMarketValue(portfolio) {
  return (Array.isArray(portfolio) ? portfolio : []).reduce((sum, item) => {
    return sum + Number(item.qty || 0) * Number(item.mkt || 0);
  }, 0);
}

async function preflightIntent(intent, event) {
  const availability = approvalAvailability();
  if (!availability.ready) throw new Error(`LIVE_APPROVAL_NOT_READY:${JSON.stringify(availability)}`);
  const session = isContinuousSession(new Date());
  if (!session.open) throw new Error(`MARKET_NOT_IN_CONTINUOUS_SESSION:${session.reason}`);
  if (isExpired(intent)) throw new Error('INTENT_EXPIRED');
  if (!['SELL', 'BUY'].includes(intent.side)) throw new Error('UNSUPPORTED_SIDE');
  if (intent.portfolioBucket !== 'ACTIVE') throw new Error('ONLY_ACTIVE_INTENTS_ALLOWED');
  if (!ALLOWED_DECISION_AUTHORITIES.has(intent.decisionAuthority)) {
    throw new Error('INTENT_DECISION_AUTHORITY_NOT_ALLOWED');
  }

  const dataResponse = await callInvx({ action: 'getData', event });
  if (dataResponse.statusCode !== 200) throw new Error(`PORTFOLIO_FETCH_FAILED:${dataResponse.statusCode}`);
  const portfolio = Array.isArray(dataResponse.payload.portfolio) ? dataResponse.payload.portfolio : [];
  const cash = Number(dataResponse.payload.cash || 0);
  const position = portfolio.find((item) => String(item.sym || '').toUpperCase() === intent.symbol);

  if (intent.side === 'SELL') {
    if (!position) throw new Error('POSITION_NOT_FOUND');
    const heldQty = Math.floor(Number(position.qty || 0));
    if (intent.quantity > heldQty) throw new Error('SELL_QUANTITY_EXCEEDS_POSITION');
    if (intent.quantity === heldQty) {
      if (!isCandidateDrFullExit(intent, heldQty)) throw new Error('FULL_POSITION_EXIT_BLOCKED');
    } else {
      const maxFraction = numberEnv('MAX_LIVE_POSITION_FRACTION', 0.25);
      if (intent.quantity > Math.floor(heldQty * maxFraction)) throw new Error('POSITION_FRACTION_LIMIT_EXCEEDED');
    }
  }

  const rawOrders = await fetchRawOrders();
  if (hasDuplicateOpenOrder(rawOrders, intent)) throw new Error('DUPLICATE_OPEN_ORDER');

  const quoteResponse = await callInvx({ action: 'quote', query: { sym: intent.symbol }, event });
  if (quoteResponse.statusCode !== 200) throw new Error(`QUOTE_FETCH_FAILED:${quoteResponse.statusCode}`);
  const market = validateMarketData(intent, quoteResponse.payload);
  const submittedValue = Number((intent.quantity * market.executionPrice).toFixed(2));

  const maxOrderValue = numberEnv('MAX_LIVE_ORDER_VALUE', 0);
  if (maxOrderValue <= 0 || submittedValue > maxOrderValue) throw new Error('ORDER_VALUE_LIMIT_EXCEEDED');

  if (intent.side === 'BUY') {
    const reserve = Math.max(0, numberEnv('MIN_LIVE_CASH_RESERVE', 5000));
    const estimatedCostBuffer = submittedValue * 0.01;
    if (cash - submittedValue - estimatedCostBuffer < reserve) throw new Error('CASH_RESERVE_WOULD_BE_BREACHED');

    const totalMarketValue = portfolioMarketValue(portfolio) + cash;
    const currentValue = position ? Number(position.qty || 0) * Number(position.mkt || 0) : 0;
    const postTradeWeight = totalMarketValue > 0 ? (currentValue + submittedValue) / totalMarketValue : 1;
    const maxPositionWeight = numberEnv('MAX_LIVE_ACTIVE_POSITION_WEIGHT', 0.05);
    if (postTradeWeight > maxPositionWeight) throw new Error(`ACTIVE_POSITION_WEIGHT_LIMIT:${postTradeWeight.toFixed(4)}`);
  }

  const dailyStats = await getDailyExecutionStats(event, new Date(), {
    excludeIntentId: intent.id,
  });
  const maxDailyOrders = Math.max(1, Math.floor(numberEnv('MAX_DAILY_APPROVED_ORDERS', 1)));
  const maxDailyNotional = numberEnv('MAX_DAILY_APPROVED_NOTIONAL', 0);
  if (dailyStats.count >= maxDailyOrders) throw new Error('DAILY_ORDER_COUNT_LIMIT');
  if (maxDailyNotional <= 0 || dailyStats.notional + submittedValue > maxDailyNotional) {
    throw new Error('DAILY_NOTIONAL_LIMIT');
  }

  return { position, portfolio, cash, rawOrders, market, submittedValue, dailyStats };
}

function brokerStatusToIntentStatus(status) {
  return normalizeBrokerOrderState(status);
}

async function executeApprovedIntent(intentId, approver, event) {
  const initial = await getIntent(intentId, event);
  if (!initial) throw new Error('INTENT_NOT_FOUND');
  if (initial.status !== 'PENDING_APPROVAL') throw new Error(`INTENT_NOT_PENDING:${initial.status}`);

  if (isExpired(initial)) {
    await transitionIntent(intentId, 'PENDING_APPROVAL', 'EXPIRED', {}, {
      event,
      actor: approver,
      note: 'Approval attempted after expiry',
    });
    return { executed: false, status: 'EXPIRED', intent: initial };
  }

  const availability = approvalAvailability();
  if (!availability.ready) return { executed: false, status: 'LIVE_LOCKED', availability, intent: initial };

  const approving = await transitionIntent(intentId, 'PENDING_APPROVAL', 'APPROVING', {
    approval: { approvedAt: new Date().toISOString(), approver },
  }, { event, actor: approver });

  let preflight;
  try {
    preflight = await preflightIntent(approving, event);
    if (boolEnv('OPERATIONAL_PILOT_MODE')) {
      await reserveOperationalPilotAttempt(approving, event);
    }
  } catch (error) {
    const failed = await transitionIntent(intentId, 'APPROVING', 'FAILED_PRECHECK', {
      lastError: error.message,
    }, { event, actor: 'risk-engine', note: error.message });
    return { executed: false, status: failed.status, error: error.message, intent: failed };
  }

  const orderBody = {
    ticker: approving.symbol,
    side: approving.side === 'BUY' ? 'Buy' : 'Sell',
    quantity: approving.quantity,
    price: preflight.market.executionPrice,
  };

  const attemptedAt = new Date().toISOString();
  const submitting = await transitionIntent(intentId, 'APPROVING', 'SUBMITTING', {
    broker: {
      attemptedAt,
      submittedAt: attemptedAt,
      request: orderBody,
      submittedPrice: preflight.market.executionPrice,
      submittedValue: preflight.submittedValue,
      orderStyle: preflight.market.orderStyle,
    },
  }, {
    event,
    actor: 'execution-engine',
    note: 'Durable attempt marker written before broker request; never auto-resubmit',
  });

  let orderResponse;
  try {
    orderResponse = await callInvx({
      action: 'order',
      method: 'POST',
      body: orderBody,
      intentId,
      event,
    });
  } catch (error) {
    const uncertain = await transitionIntent(intentId, 'SUBMITTING', 'EXECUTION_UNCERTAIN', {
      lastError: error.message,
      broker: submitting.broker,
    }, { event, actor: 'execution-engine', note: 'Transport failure after order attempt' });
    return { executed: false, status: uncertain.status, error: error.message, intent: uncertain };
  }

  const orderId = orderResponse.payload.orderId || orderResponse.payload.order_id || orderResponse.payload.orderNo ||
    orderResponse.payload.data?.orderId || orderResponse.payload.data?.order_id ||
    orderResponse.payload.data?.orderNo || null;
  const success = orderResponse.statusCode >= 200 && orderResponse.statusCode < 300 &&
    Boolean(orderId) && orderResponse.payload._success !== false;

  if (!success) {
    const uncertain = await transitionIntent(intentId, 'SUBMITTING', 'EXECUTION_UNCERTAIN', {
      lastError: orderResponse.payload._error_msg || `BROKER_HTTP_${orderResponse.statusCode}`,
      broker: {
        ...submitting.broker,
        responseStatus: orderResponse.statusCode,
      },
    }, { event, actor: 'execution-engine', note: 'Broker response did not prove rejection or acceptance' });
    return { executed: false, status: uncertain.status, error: uncertain.lastError, intent: uncertain };
  }

  const submitted = await transitionIntent(intentId, 'SUBMITTING', 'SUBMITTED', {
    broker: {
      ...submitting.broker,
      orderId,
      responseStatus: orderResponse.statusCode,
    },
  }, { event, actor: 'execution-engine' });

  await sleep(1500);
  let matched = null;
  try {
    const brokerOrders = await fetchRawOrders();
    matched = brokerOrders.find((order) => String(order.id || '') === String(orderId));
  } catch (error) {
    console.warn('[approval-executor] reconciliation read failed:', error.message);
  }

  if (!matched) {
    const pending = await transitionIntent(intentId, 'SUBMITTED', 'RECONCILE_PENDING', {}, {
      event,
      actor: 'reconciliation-engine',
      note: 'Order ID not visible in first reconciliation read; never auto-resubmit',
    });
    return { executed: true, status: pending.status, intent: pending };
  }

  const nextStatus = normalizeBrokerOrderState(matched);
  const reconciled = await transitionIntent(intentId, 'SUBMITTED', nextStatus, {
    broker: {
      ...submitted.broker,
      reconciledAt: new Date().toISOString(),
      brokerStatus: matched.status,
      matchedQuantity: matched.matchedQuantity,
    },
  }, { event, actor: 'reconciliation-engine' });

  return { executed: true, status: reconciled.status, intent: reconciled };
}

async function rejectIntent(intentId, approver, event) {
  const intent = await getIntent(intentId, event);
  if (!intent) throw new Error('INTENT_NOT_FOUND');
  if (intent.status !== 'PENDING_APPROVAL') throw new Error(`INTENT_NOT_PENDING:${intent.status}`);
  return transitionIntent(intentId, 'PENDING_APPROVAL', 'REJECTED', {
    approval: { rejectedAt: new Date().toISOString(), approver },
  }, { event, actor: approver });
}

module.exports = {
  ALLOWED_DECISION_AUTHORITIES,
  approvalAvailability,
  isThaiContinuousSession,
  validateMarketData,
  hasDuplicateOpenOrder,
  portfolioMarketValue,
  preflightIntent,
  executeApprovedIntent,
  approveIntent,
  rejectIntent,
  _test: {
    bkkClock,
    intentGateSignature,
    signaturePayload,
    normalizeSignedOrderBody,
    normalizeOrderSide,
    brokerStatusToIntentStatus,
  },
};
