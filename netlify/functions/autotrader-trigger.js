// Netlify Function: /api/autotrader-trigger
// Safe manual trigger for the Auto Trader.
//
// POST /api/autotrader-trigger?mode=analyze  -> analysis only
// POST /api/autotrader-trigger?mode=dry_run  -> simulation only
// POST /api/autotrader-trigger?mode=execute  -> real orders, protected by multiple locks

const crypto = require('crypto');
const { runAutoTrader } = require('./autotrade');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';
const EXECUTE_CONFIRMATION = process.env.EXECUTE_CONFIRMATION || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token, x-execute-confirmation',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(data, null, 2),
  };
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed', allowed: ['POST'] });
  }

  // ADMIN_TOKEN is mandatory for every manual trigger. Fail closed if missing.
  if (!ADMIN_TOKEN) {
    return jsonResponse(503, {
      error: 'Manual trigger disabled: ADMIN_TOKEN is not configured',
      safeDefault: true,
    });
  }

  const providedToken = event.headers?.['x-admin-token'] || event.headers?.['X-Admin-Token'] || '';
  if (!safeEqual(providedToken, ADMIN_TOKEN)) {
    console.warn('[autotrader-trigger] Unauthorized request');
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch {
      return jsonResponse(400, { error: 'Invalid JSON body' });
    }
  }

  let mode = event.queryStringParameters?.mode || body.mode || 'analyze';
  const validModes = ['analyze', 'dry_run', 'execute'];
  if (!validModes.includes(mode)) mode = 'analyze';

  // Real execution needs two independent server-side locks plus request confirmation.
  if (mode === 'execute') {
    if (!LIVE_TRADING_ENABLED) {
      return jsonResponse(423, {
        error: 'Live trading is locked',
        required: 'Set LIVE_TRADING_ENABLED=true only after shadow testing and approval',
      });
    }
    if (!EXECUTE_CONFIRMATION) {
      return jsonResponse(503, {
        error: 'Live trading disabled: EXECUTE_CONFIRMATION is not configured',
      });
    }
    const providedConfirmation = event.headers?.['x-execute-confirmation'] || '';
    if (!safeEqual(providedConfirmation, EXECUTE_CONFIRMATION)) {
      return jsonResponse(401, { error: 'Missing or invalid execute confirmation' });
    }
  }

  try {
    // Never trust client-supplied portfolio for live execution.
    const clientPortfolio = mode === 'execute' ? null :
      (Array.isArray(body.portfolio) && body.portfolio.length > 0 ? body.portfolio : null);

    const result = await runAutoTrader(mode, clientPortfolio);
    return jsonResponse(200, {
      ok: true,
      mode: result.mode,
      timestamp: result.timestamp,
      orders_placed: result.orders_placed,
      orders_failed: result.orders_failed,
      analyzed: result.analyzed,
      alerts: result.alerts,
      summary: result.summary,
    });
  } catch (err) {
    console.error('[autotrader-trigger] Fatal error:', err);
    return jsonResponse(500, {
      error: 'Auto-trader failed',
      detail: err.message,
      orders_placed: [],
      orders_failed: [],
      analyzed: [],
      alerts: [],
    });
  }
};
