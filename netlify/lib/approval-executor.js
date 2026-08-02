const crypto = require('crypto');
const { handler: secureInvxHandler } = require('../functions/invx');
const { fetchRawOrders } = require('./settrade-read');
const {
  getIntent,
  transitionIntent,
  getDailyExecutionStats,
  isExpired,
} = require('./order-intent-store');

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

function approvalAvailability() {
  const required = [
    'ADMIN_TOKEN',
    'EXECUTE_CONFIRMATION',
    'ORDER_INTENT_GATE_SECRET',
    'INVX_KEY',
    'INVX_SECRET',
    'INVX_PIN',
    'INVX_ACCOUNT',
  ];
  const missing = required.filter((name) => !process.env[name]);
  const maxOrderValue = numberEnv('MAX_LIVE_ORDER_VALUE', 0);
  const maxDailyNotional = numberEnv('MAX_DAILY_APPROVED_NOTIONAL', 0);

  return {
    ready:
      boolEnv('LIVE_TRADING_ENABLED') &&
      boolEnv('HUMAN_APPROVAL_LIVE_ENABLED') &&
      missing.length === 0 &&
      maxOrderValue > 0 &&
      maxDailyNotional > 0,
    liveTradingEnabled: boolEnv('LIVE_TRADING_ENABLED'),
    humanApprovalEnabled: boolEnv('HUMAN_APPROVAL_LIVE_ENABLED'),
    missing,
    maxOrderValue,
    maxDailyNotional,
  };
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
  const { weekday, minutes } = bkkClock(date);
  if (weekday < 1 || weekday > 5) return false;
  return (minutes >= 10 * 60 + 5 && minutes <= 12 * 60 + 25) ||
    (minutes >= 14 * 60 + 5 && minutes <= 16 * 60 + 20);
}

function intentGateSignature(intentId) {
  const secret = process.env.ORDER_INTENT_GATE_SECRET || '';
  if (!secret) throw new Error('ORDER_INTENT_GATE_SECRET_NOT_CONFIGURED');
  return crypto.createHmac('sha256', secret).update(String(intentId)).digest('hex');
}

async function callInvx({ action, method = 'GET', body = null, query = {}, intentId = null, event = null }) {
  const headers = {};
  if (action === 'order') {
    headers['x-admin-token'] = process.env.ADMIN_TOKEN || '';
    headers['x-execute-confirmation'] = process.env.EXECUTE_CONFIRMATION || '';
    headers['x-order-intent-id'] = intentId || '';
    headers['x-order-intent-signature'] = intentGateSignature(intentId);
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
  const terminal = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'];
  return (Array.isArray(orders) ? orders : []).some((order) => {
    const status = String(order.status || '').toUpperCase();
    return String(order.symbol || order.sym || '').toUpperCase() === intent.symbol &&
      normalizeOrderSide(order.side) === intent.side &&
      !terminal.some((word) => status.includes(word));
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

  const executionPrice = intent.side === 'SELL' ? bid : ask;
  const driftPct = Math.abs(executionPrice - intent.proposedPrice) / intent.proposedPrice;
  const maxDriftPct = numberEnv('MAX_PRICE_DRIFT_PCT', 0.02);
  if (driftPct > maxDriftPct) throw new Error(`PRICE_DRIFT_TOO_HIGH:${driftPct.toFixed(4)}`);

  return { last, bid, ask, spreadPct, driftPct, executionPrice };
}

async function preflightIntent(intent, event) {
  const availability = approvalAvailability();
  if (!availability.ready) throw new Error(`LIVE_APPROVAL_NOT_READY:${JSON.stringify(availability)}`);
  if (!isThaiContinuousSession()) throw new Error('MARKET_NOT_IN_CONTINUOUS_SESSION');
  if (isExpired(intent)) throw new Error('INTENT_EXPIRED');
  if (!['SELL', 'BUY'].includes(intent.side)) throw new Error('UNSUPPORTED_SIDE');
  if (intent.portfolioBucket === 'CORE') throw new Error('CORE_POSITION_REQUIRES_THESIS_BREAK_REVIEW');

  const dataResponse = await callInvx({ action: 'getData', event });
  if (dataResponse.statusCode !== 200) throw new Error(`PORTFOLIO_FETCH_FAILED:${dataResponse.statusCode}`);
  const portfolio = Array.isArray(dataResponse.payload.portfolio) ? dataResponse.payload.portfolio : [];
  const position = portfolio.find((item) => String(item.sym || '').toUpperCase() === intent.symbol);

  if (intent.side === 'SELL') {
    if (!position) throw new Error('POSITION_NOT_FOUND');
    const heldQty = Math.floor(Number(position.qty || 0));
    if (intent.quantity >= heldQty) throw new Error('FULL_POSITION_EXIT_BLOCKED');
    const maxFraction = numberEnv('MAX_LIVE_POSITION_FRACTION', 0.25);
    if (intent.quantity > Math.floor(heldQty * maxFraction)) throw new Error('POSITION_FRACTION_LIMIT_EXCEEDED');
  }

  const rawOrders = await fetchRawOrders();
  if (hasDuplicateOpenOrder(rawOrders, intent)) throw new Error('DUPLICATE_OPEN_ORDER');

  const quoteResponse = await callInvx({ action: 'quote', query: { sym: intent.symbol }, event });
  if (quoteResponse.statusCode !== 200) throw new Error(`QUOTE_FETCH_FAILED:${quoteResponse.statusCode}`);
  const market = validateMarketData(intent, quoteResponse.payload);
  const submittedValue = Number((intent.quantity * market.executionPrice).toFixed(2));

  const maxOrderValue = numberEnv('MAX_LIVE_ORDER_VALUE', 0);
  if (maxOrderValue <= 0 || submittedValue > maxOrderValue) throw new Error('ORDER_VALUE_LIMIT_EXCEEDED');

  const dailyStats = await getDailyExecutionStats(event, new Date());
  const maxDailyOrders = Math.max(1, Math.floor(numberEnv('MAX_DAILY_APPROVED_ORDERS', 1)));
  const maxDailyNotional = numberEnv('MAX_DAILY_APPROVED_NOTIONAL', 0);
  if (dailyStats.count >= maxDailyOrders) throw new Error('DAILY_ORDER_COUNT_LIMIT');
  if (maxDailyNotional <= 0 || dailyStats.notional + submittedValue > maxDailyNotional) {
    throw new Error('DAILY_NOTIONAL_LIMIT');
  }

  return { position, rawOrders, market, submittedValue, dailyStats };
}

function brokerStatusToIntentStatus(status) {
  const value = String(status || '').toUpperCase();
  if (value.includes('PART')) return 'PARTIALLY_FILLED';
  if (value.includes('FILL') || value.includes('MATCH')) return 'FILLED';
  if (value.includes('REJECT')) return 'REJECTED_BY_BROKER';
  if (value.includes('CANCEL')) return 'CANCELLED';
  return 'ACKNOWLEDGED';
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
    const uncertain = await transitionIntent(intentId, 'APPROVING', 'EXECUTION_UNCERTAIN', {
      lastError: error.message,
      broker: { submittedAt: new Date().toISOString(), request: orderBody },
    }, { event, actor: 'execution-engine', note: 'Transport failure after order attempt' });
    return { executed: false, status: uncertain.status, error: error.message, intent: uncertain };
  }

  const orderId = orderResponse.payload.orderId || orderResponse.payload.order_id || orderResponse.payload.orderNo ||
    orderResponse.payload.data?.orderId || null;
  const success = orderResponse.statusCode >= 200 && orderResponse.statusCode < 300 &&
    (orderResponse.payload._success === true || Boolean(orderId));

  if (!success) {
    const uncertain = await transitionIntent(intentId, 'APPROVING', 'EXECUTION_UNCERTAIN', {
      lastError: orderResponse.payload._error_msg || `BROKER_HTTP_${orderResponse.statusCode}`,
      broker: {
        submittedAt: new Date().toISOString(),
        request: orderBody,
        responseStatus: orderResponse.statusCode,
      },
    }, { event, actor: 'execution-engine', note: 'Broker response did not prove rejection or acceptance' });
    return { executed: false, status: uncertain.status, error: uncertain.lastError, intent: uncertain };
  }

  const submitted = await transitionIntent(intentId, 'APPROVING', 'SUBMITTED', {
    broker: {
      orderId,
      submittedAt: new Date().toISOString(),
      submittedPrice: preflight.market.executionPrice,
      submittedValue: preflight.submittedValue,
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

  const nextStatus = brokerStatusToIntentStatus(matched.status);
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
  approvalAvailability,
  isThaiContinuousSession,
  validateMarketData,
  hasDuplicateOpenOrder,
  preflightIntent,
  executeApprovedIntent,
  rejectIntent,
  _test: { bkkClock, intentGateSignature, normalizeOrderSide, brokerStatusToIntentStatus },
};
