const STORE_NAME = 'strategy-research-results-v1';
const PREFIX = 'backtest/';
let modulePromise = null;
let connected = false;

function loadBlobs() {
  if (!modulePromise) modulePromise = import('@netlify/blobs');
  return modulePromise;
}

async function getStore(event) {
  const mod = await loadBlobs();
  if (!connected && typeof mod.connectLambda === 'function' && event) {
    try { mod.connectLambda(event); }
    catch (error) { console.warn('[research-store] connectLambda skipped:', error.message); }
    connected = true;
  }
  return mod.getStore({ name: STORE_NAME, consistency: 'strong' });
}

function normalizeSymbol(symbol) {
  const value = String(symbol || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,20}$/.test(value)) throw new Error('INVALID_SYMBOL');
  return value;
}

function keyFor(symbol) {
  return `${PREFIX}${normalizeSymbol(symbol)}.json`;
}

function evaluateBacktestGate(result, requirements = {}) {
  const metrics = result?.metrics || {};
  const minimumTrades = Number(requirements.minimumTrades ?? 5);
  const minimumDecisions = Number(requirements.minimumDecisions ?? 100);
  const maximumDrawdown = Number(requirements.maximumDrawdown ?? -0.25);
  const requirePositiveReturn = requirements.requirePositiveReturn !== false;
  const requirePositiveExcess = requirements.requirePositiveExcess !== false;

  const checks = {
    resultExists: Boolean(result),
    completedTrades: Number(metrics.completedTrades || 0) >= minimumTrades,
    decisionEvents: Number(result?.decisionLog?.length || 0) >= minimumDecisions,
    positiveAfterCosts: !requirePositiveReturn || Number(metrics.totalReturn || 0) > 0,
    beatsBenchmark: !requirePositiveExcess || Number(metrics.excessVsBenchmark || 0) > 0,
    drawdownWithinLimit: Number(metrics.maxDrawdown || 0) >= maximumDrawdown,
    finiteMetrics: [metrics.totalReturn, metrics.maxDrawdown, metrics.cagr]
      .every((value) => Number.isFinite(Number(value))),
  };

  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    requirements: { minimumTrades, minimumDecisions, maximumDrawdown, requirePositiveReturn, requirePositiveExcess },
  };
}

async function saveBacktestResult(symbol, result, event, requirements = {}) {
  const store = await getStore(event);
  const normalized = normalizeSymbol(symbol);
  const gate = evaluateBacktestGate(result, requirements);
  const payload = {
    schemaVersion: 1,
    symbol: normalized,
    recordedAt: new Date().toISOString(),
    gate,
    result,
  };
  await store.set(keyFor(normalized), JSON.stringify(payload), {
    metadata: {
      symbol: normalized,
      recordedAt: payload.recordedAt,
      passed: gate.passed,
      totalReturn: Number(result?.metrics?.totalReturn || 0),
    },
  });
  return payload;
}

async function getBacktestResult(symbol, event) {
  const store = await getStore(event);
  return store.get(keyFor(symbol), { type: 'json', consistency: 'strong' });
}

async function listBacktestResults(event) {
  const store = await getStore(event);
  const { blobs } = await store.list({ prefix: PREFIX });
  const rows = [];
  for (const blob of blobs) {
    const item = await store.get(blob.key, { type: 'json', consistency: 'strong' });
    if (item) rows.push(item);
  }
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

module.exports = {
  evaluateBacktestGate,
  saveBacktestResult,
  getBacktestResult,
  listBacktestResults,
};
