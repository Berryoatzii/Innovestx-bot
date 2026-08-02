// Manual shadow-analysis trigger.
// Direct execution is intentionally unavailable; use Telegram order-intent approval.

const crypto = require('crypto');
const { runAutoTrader } = require('./autotrade');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
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

  if (!ADMIN_TOKEN) {
    return jsonResponse(503, {
      error: 'Manual trigger disabled: ADMIN_TOKEN is not configured',
      safeDefault: true,
    });
  }

  const providedToken = event.headers?.['x-admin-token'] || event.headers?.['X-Admin-Token'] || '';
  if (!safeEqual(providedToken, ADMIN_TOKEN)) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); }
    catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }
  }

  let mode = event.queryStringParameters?.mode || body.mode || 'analyze';
  if (mode === 'execute') {
    return jsonResponse(405, {
      error: 'Direct execute is disabled',
      requiredFlow: 'shadow signal -> order intent -> Telegram human approval -> broker preflight',
    });
  }
  if (!['analyze', 'dry_run'].includes(mode)) mode = 'analyze';

  try {
    const clientPortfolio = Array.isArray(body.portfolio) && body.portfolio.length > 0
      ? body.portfolio
      : null;
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
      note: 'No live order can be sent from this endpoint',
    });
  } catch (err) {
    return jsonResponse(500, {
      error: 'Auto-trader analysis failed',
      detail: err.message,
      orders_placed: [],
      orders_failed: [],
      analyzed: [],
      alerts: [],
    });
  }
};
