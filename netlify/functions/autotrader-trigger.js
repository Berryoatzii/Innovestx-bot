// Netlify Function: /api/autotrader-trigger
// HTTP endpoint for manual triggering of the Auto Trader from the dashboard
//
// GET/POST  /api/autotrader-trigger?mode=analyze   → analyze only (default)
// GET/POST  /api/autotrader-trigger?mode=execute   → place real orders
// GET/POST  /api/autotrader-trigger?mode=dry_run   → log only, no Telegram
//
// Auth: if ADMIN_TOKEN env var is set, request must include header:
//   x-admin-token: <your-token>

const { runAutoTrader } = require('./autotrade');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(data, null, 2),
  };
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  // Only allow GET and POST
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed', allowed: ['GET', 'POST'] });
  }

  // ── Auth check ───────────────────────────────────────────────────────────────
  if (ADMIN_TOKEN) {
    const providedToken =
      event.headers?.['x-admin-token'] ||
      event.headers?.['X-Admin-Token'] ||
      event.queryStringParameters?.token ||
      '';

    if (providedToken !== ADMIN_TOKEN) {
      console.warn('[autotrader-trigger] Unauthorized request from', event.headers?.['x-forwarded-for'] || 'unknown IP');
      return jsonResponse(401, { error: 'Unauthorized — invalid or missing x-admin-token header' });
    }
  }

  // ── Parse mode + optional pre-loaded portfolio ───────────────────────────────
  let mode = event.queryStringParameters?.mode || '';
  let clientPortfolio = null;

  if (event.body) {
    try {
      const body = JSON.parse(event.body);
      if (!mode) mode = body.mode || '';
      // Accept pre-loaded portfolio from dashboard — avoids double InnovestX fetch
      if (Array.isArray(body.portfolio) && body.portfolio.length > 0) {
        clientPortfolio = body.portfolio;
        console.log(`[autotrader-trigger] Using client portfolio: ${clientPortfolio.length} stocks`);
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  const VALID_MODES = ['analyze', 'execute', 'dry_run'];
  if (!mode || !VALID_MODES.includes(mode)) {
    mode = 'analyze'; // safe default
  }

  console.log(`[autotrader-trigger] mode=${mode} clientPortfolio=${clientPortfolio?.length ?? 'none'}`);

  // ── Run the trader ────────────────────────────────────────────────────────────
  try {
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
      error: err.message,
      orders_placed: [],
      orders_failed: [],
      analyzed: [],
      alerts: [],
      summary: `Fatal error: ${err.message}`,
    });
  }
};
