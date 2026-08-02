// Secure gateway for InnovestX / Settrade access.
// Read-only market data remains available; every account mutation fails closed.

const crypto = require('crypto');
const { handler: engineHandler } = require('../lib/invx-engine');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const EXECUTE_CONFIRMATION = process.env.EXECUTE_CONFIRMATION || '';
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'null';

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token, x-execute-confirmation',
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
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function sanitizeEvent(event) {
  const headers = { ...(event.headers || {}) };
  delete headers['api-key'];
  delete headers['api-secret'];
  delete headers['API-KEY'];
  delete headers['API-SECRET'];

  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch { body = {}; }
  }
  delete body.api_key;
  delete body.api_secret;
  delete body.pin;

  return {
    ...event,
    headers,
    body: Object.keys(body).length ? JSON.stringify(body) : '',
  };
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
    if (!safeEqual(suppliedAdmin, ADMIN_TOKEN)) {
      return response(401, { error: 'Unauthorized' });
    }
  }

  if (isOrder) {
    if (!LIVE_TRADING_ENABLED) {
      return response(423, {
        error: 'Live trading is locked',
        required: 'LIVE_TRADING_ENABLED=true',
      });
    }

    if (!EXECUTE_CONFIRMATION) {
      return response(503, {
        error: 'Live trading disabled: EXECUTE_CONFIRMATION is not configured',
      });
    }

    const suppliedConfirmation = getHeader(event.headers, 'x-execute-confirmation');
    if (!safeEqual(suppliedConfirmation, EXECUTE_CONFIRMATION)) {
      return response(401, { error: 'Missing or invalid execute confirmation' });
    }
  }

  try {
    // Credentials and PIN are server-owned only; never trust browser-supplied values.
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
