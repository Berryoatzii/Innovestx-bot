const { openBlobStore } = require('./blob-runtime');

const STORE_NAME = 'strategy-shadow-v1';
const STATE_KEY = 'state/portfolio.json';
const REPORT_PREFIX = 'report/';

async function getStore(event, consistency = 'eventual') {
  return openBlobStore(STORE_NAME, { event, consistency });
}

function defaultState(initialCapital = 100000) {
  return {
    schemaVersion: 1,
    strategyVersion: 'MOMENTUM_BREAKOUT_V1.0.0',
    initialCapital,
    cash: initialCapital,
    positions: {},
    trades: [],
    equity: initialCapital,
    peakEquity: initialCapital,
    maxDrawdown: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function getShadowState(event, initialCapital = 100000) {
  const store = await getStore(event, 'prefer-strong');
  const record = await store.getWithMetadata(STATE_KEY, { type: 'json' });
  if (!record) return { data: defaultState(initialCapital), etag: null, store };
  return { data: record.data, etag: record.etag || null, store };
}

async function saveShadowState(state, event, expectedEtag = null) {
  const store = await getStore(event, 'prefer-strong');
  const next = { ...state, updatedAt: new Date().toISOString() };
  const options = {
    metadata: { updatedAt: next.updatedAt, equity: next.equity, positions: Object.keys(next.positions || {}).length },
  };
  if (expectedEtag) options.onlyIfMatch = expectedEtag;
  else options.onlyIfNew = true;
  try {
    await store.set(STATE_KEY, JSON.stringify(next), options);
  } catch (error) {
    if (!expectedEtag) {
      const existing = await store.getWithMetadata(STATE_KEY, { type: 'json' });
      if (existing?.etag) throw new Error('SHADOW_STATE_ALREADY_INITIALIZED_RETRY');
    }
    throw new Error(`SHADOW_STATE_CONFLICT:${error.message}`);
  }
  return next;
}

function reportKey(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('INVALID_REPORT_DATE');
  return `${REPORT_PREFIX}${date}.json`;
}

async function saveDailyReport(date, report, event) {
  const store = await getStore(event, 'prefer-strong');
  const key = reportKey(date);
  const payload = {
    schemaVersion: 1,
    date,
    recordedAt: new Date().toISOString(),
    ...report,
  };
  try {
    await store.set(key, JSON.stringify(payload), {
      onlyIfNew: true,
      metadata: {
        date,
        equity: Number(payload.equity || 0),
        decisionEvents: Number(payload.decisionEvents || 0),
      },
    });
    return { report: payload, created: true };
  } catch (error) {
    const existing = await store.get(key, { type: 'json' });
    if (existing) return { report: existing, created: false };
    throw error;
  }
}

async function listDailyReports(event, limit = 400) {
  const store = await getStore(event);
  const { blobs } = await store.list({ prefix: REPORT_PREFIX });
  const selected = blobs.slice(-Math.max(1, Math.min(1000, limit)));
  const reports = [];
  for (const blob of selected) {
    const report = await store.get(blob.key, { type: 'json' });
    if (report) reports.push(report);
  }
  return reports.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function evaluateShadowGate(reports, requirements = {}) {
  const minimumDays = Number(requirements.minimumDays || 20);
  const minimumEvents = Number(requirements.minimumEvents || 100);
  const rows = Array.isArray(reports) ? reports : [];
  const tradingDays = new Set(rows.filter((item) => item.marketOpenDay !== false).map((item) => item.date)).size;
  const decisionEvents = rows.reduce((sum, item) => sum + Number(item.decisionEvents || 0), 0);
  const duplicates = rows.reduce((sum, item) => sum + Number(item.duplicateIntentAttempts || 0), 0);
  const unauthorized = rows.reduce((sum, item) => sum + Number(item.unauthorizedExecutionAttempts || 0), 0);
  const dataFailures = rows.reduce((sum, item) => sum + Number(item.dataQualityFailures || 0), 0);
  const benchmarkRows = rows.filter((item) => Number(item.setTriValue || 0) > 0);
  const benchmarkCoverage = rows.length > 0 ? benchmarkRows.length / rows.length : 0;
  const latest = rows[rows.length - 1] || null;

  const checks = {
    minimumTradingDays: tradingDays >= minimumDays,
    minimumDecisionEvents: decisionEvents >= minimumEvents,
    zeroDuplicateIntents: duplicates === 0,
    zeroUnauthorizedExecution: unauthorized === 0,
    benchmarkCoverage: benchmarkCoverage >= 0.90,
    latestReportExists: Boolean(latest),
  };

  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    tradingDays,
    decisionEvents,
    duplicates,
    unauthorized,
    dataFailures,
    benchmarkCoverage,
    latest,
  };
}

module.exports = {
  defaultState,
  getShadowState,
  saveShadowState,
  saveDailyReport,
  listDailyReports,
  evaluateShadowGate,
  _test: { reportKey },
};
