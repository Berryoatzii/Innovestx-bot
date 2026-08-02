// Safe entry point for scheduled and manual auto-trading.
// The original trading engine lives outside the deployable functions folder.

const { runAutoTrader: runEngine } = require('../lib/autotrade-engine');

const VALID_MODES = new Set(['analyze', 'dry_run', 'execute']);
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';
const SCHEDULED_LIVE_TRADING_ENABLED = process.env.SCHEDULED_LIVE_TRADING_ENABLED === 'true';

function normalizeMode(mode) {
  return VALID_MODES.has(mode) ? mode : 'dry_run';
}

async function runAutoTrader(mode = 'dry_run', portfolioOverride = null) {
  const safeMode = normalizeMode(mode);

  // Fail closed: no caller may execute real orders unless the global live lock is enabled.
  if (safeMode === 'execute' && !LIVE_TRADING_ENABLED) {
    throw new Error('Live trading is locked: LIVE_TRADING_ENABLED is not true');
  }

  // Never trust browser-provided positions for real orders.
  const safePortfolioOverride = safeMode === 'execute' ? null : portfolioOverride;
  return runEngine(safeMode, safePortfolioOverride);
}

exports.handler = async () => {
  let mode = normalizeMode(process.env.SCHEDULED_TRADE_MODE || 'dry_run');

  // Scheduled real-money execution needs a second independent server-side lock.
  if (mode === 'execute' && !SCHEDULED_LIVE_TRADING_ENABLED) {
    console.warn('[AutoTrader] Scheduled execute requested but locked; falling back to dry_run');
    mode = 'dry_run';
  }

  console.log('[AutoTrader] Safe scheduled run | mode:', mode);

  try {
    const result = await runAutoTrader(mode, null);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: true,
        mode: result.mode,
        timestamp: result.timestamp,
        simulated_or_placed: result.orders_placed.length,
        failed: result.orders_failed.length,
        summary: result.summary,
      }),
    };
  } catch (err) {
    console.error('[AutoTrader] Safe wrapper failure:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, mode, error: err.message }),
    };
  }
};

module.exports.runAutoTrader = runAutoTrader;
