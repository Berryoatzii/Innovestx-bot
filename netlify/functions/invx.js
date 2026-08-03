// Secure gateway for InnovestX / Settrade access.
// Read-only market data remains available; every account mutation fails closed.

const crypto = require('crypto');
const { handler: engineHandler } = require('../lib/invx-engine');
const { getIntent } = require('../lib/order-intent-store');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const EXECUTE_CONFIRMATION = process.env.EXECUTE_CONFIRMATION || '';
const ORDER_INTENT_GATE_SECRET = process.env.ORDER_INTENT_GATE_SECRET || '';
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';
const HUMAN_APPROVAL_ONLY = process.env.HUMAN_APPROVAL_ONLY !== 'false';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'null';
const ALLOWED_DECISION_AUTHORITIES = new Set([
  'DETERMINISTIC_RULES_PLUS_HUMAN_APPROVAL',
  'HUMAN_OPERATOR_LIMIT_DRAFT_PLUS_RISK_APPROVAL',
]);

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': [
    'Content-Type',
    'x-admin-token',
    'x-execute-confirmation',
    'x-order-intent-id',
    'x-order-intent-signature',
  ].join(', '),
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function response(statusCode, data) {
  return { statusCode, headers: BASE_HEADERS, body: JSON.stringify(data) };
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function getHeader(headers, name) {
  if (!headers) return '';
  const target = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => String(key).toLowerCase() === target);
  return match ? match[1] : '';
}

function parseBody(event) {
  if (!event.body) return {};
  try { return JSON.parse(event.body); }
  catch { return {}; }
}

function normalizeOrderBody(body = {}) {
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
  const normalized = normalizeOrderBody(orderBody);
  return [
    String(intentId || '').toLowerCase(),
    normalized.symbol,
    normalized.side,
    String(normalized.quantity),
    Number(normalized.price || 0).toFixed(4),
  ].join('|');
}

function expectedIntentSignature(intentId, orderBody = {}) {
  if (!ORDER_INTENT_GATE_SECRET) return '';
  return crypto.createHmac('sha256', ORDER_INTENT_GATE_SECRET)
    .update(signaturePayload(intentId, orderBody))
    .digest('hex');
}

function sanitizeEvent(event) {
  const headers = { ...(event.headers || {}) };
  for (const key of Object.keys(headers)) {
    if (['api-key', 'api-secret'].includes(String(key).toLowerCase())) delete headers[key];
  }

  const body = parseBody(event);
  delete body.api_key;
  delete body.api_secret;
  delete body.pin;

  return {
    ...event,
    headers,
    body: Object.keys(body).length ? JSON.stringify(body) : '',
  };
}

async function validateIntentBinding(event, intentId, suppliedSignature) {
  const rawBody = parseBody(event);
  const order = normalizeOrderBody(rawBody);
  if (!order.symbol || !['BUY', 'SELL'].includes(order.side) || order.quantity <= 0 || order.price <= 0) {
    throw new Error('INVALID_SIGNED_ORDER_BODY');
  }

  const expected = expectedIntentSignature(intentId, rawBody);
  if (!safeEqual(suppliedSignature, expected)) throw new Error('INVALID_ORDER_INTENT_SIGNATURE');

  // Money-moving binding must see the exact latest state or fail closed.
  const intent = await getIntent(intentId, event, { requireStrong: true });
  if (!intent) throw new Error('ORDER_INTENT_NOT_FOUND');
  if (intent.status !== 'APPROVING') throw new Error(`ORDER_INTENT_NOT_APPROVING:${intent.status}`);
  if (intent.portfolioBucket !== 'ACTIVE') throw new Error('ORDER_INTENT_BUCKET_NOT_ACTIVE');
  if (!ALLOWED_DECISION_AUTHORITIES.has(intent.decisionAuthority)) {
    throw new Error('ORDER_INTENT_AUTHORITY_INVALID');
  }
  if (intent.symbol !== order.symbol || intent.side !== order.side || Number(intent.quantity) !== order.quantity) {
    throw new Error('ORDER_BODY_DOES_NOT_MATCH_INTENT');
  }

  const orderStyle = String(intent.orderStyle || 'MARKETABLE_LIMIT').toUpperCase();
  let driftPct = 0;
  if (orderStyle === 'RESTING_LIMIT') {
    if (Math.abs(order.price - Number(intent.proposedPrice)) > 0.0001) {
      throw new Error('RESTING_LIMIT_PRICE_DOES_NOT_MATCH_INTENT');
    }
  } else {
    const maxDriftPct = Number(process.env.MAX_PRICE_DRIFT_PCT || 0.02);
    driftPct = Math.abs(order.price - Number(intent.proposedPrice)) / Number(intent.proposedPrice);
    if (!Number.isFinite(driftPct) || driftPct > maxDriftPct) throw new Error('SIGNED_ORDER_PRICE_DRIFT_EXCEEDED');
  }
  return { intent, order, driftPct, orderStyle };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: BASE_HEADERS, body: '' };
  }

  const action = event.queryStringParameters?.action || 'getData';
  const method = event.httpMethod || 'GET';
  const isOrder = action === 'order';
  const isCancel = action === 'cancel';

  if ((isOrder || isCancel) && method !== 'POST') {
    return response(405, { error: 'Mutation endpoints require POST' });
  }

  if (isOrder || isCancel) {
    if (!ADMIN_TOKEN) {
      return response(503, {
        error: 'Trading mutation disabled: ADMIN_TOKEN is not configured',
        safeDefault: true,
      });
    }
    const suppliedAdmin = getHeader(event.headers, 'x-admin-token');
    if (!safeEqual(suppliedAdmin, ADMIN_TOKEN)) return response(401, { error: 'Unauthorized' });
  }

  if (isOrder) {
    if (!LIVE_TRADING_ENABLED) {
      return response(423, { error: 'Live trading is locked', required: 'LIVE_TRADING_ENABLED=true' });
    }
    if (!EXECUTE_CONFIRMATION) {
      return response(503, { error: 'Live trading disabled: EXECUTE_CONFIRMATION is not configured' });
    }
    const suppliedConfirmation = getHeader(event.headers, 'x-execute-confirmation');
    if (!safeEqual(suppliedConfirmation, EXECUTE_CONFIRMATION)) {
      return response(401, { error: 'Missing or invalid execute confirmation' });
    }

    if (HUMAN_APPROVAL_ONLY) {
      if (!ORDER_INTENT_GATE_SECRET) return response(503, { error: 'Order intent gate is not configured' });
      const intentId = getHeader(event.headers, 'x-order-intent-id');
      const suppliedSignature = getHeader(event.headers, 'x-order-intent-signature');
      if (!/^[a-f0-9]{16}$/i.test(String(intentId || ''))) {
        return response(401, { error: 'Missing or invalid order intent ID' });
      }
      try {
        await validateIntentBinding(event, intentId, suppliedSignature);
      } catch (error) {
        return response(401, { error: error.message });
      }
    }
  }

  try {
    const result = await engineHandler(sanitizeEvent(event), {});
    return {
      ...result,
      headers: {
        ...(result.headers || {}),
        ...BASE_HEADERS,
      },
    };
  } catch (err) {
    console.error('[invx-gateway] Engine failure:', err);
    return response(500, { error: 'InnovestX gateway failed', detail: err.message });
  }
};

module.exports._test = {
  ALLOWED_DECISION_AUTHORITIES,
  safeEqual,
  expectedIntentSignature,
  signaturePayload,
  normalizeOrderBody,
  getHeader,
};