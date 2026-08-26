const test = require('node:test');
const assert = require('node:assert/strict');

function clear(path) {
  try { delete require.cache[require.resolve(path)]; } catch {}
}

function resetEnv() {
  for (const key of [
    'CORE_SYMBOLS', 'ACTIVE_SYMBOLS', 'REVIEW_SYMBOLS',
    'CORE_TARGET_WEIGHT', 'ACTIVE_TARGET_WEIGHT', 'CASH_TARGET_WEIGHT',
    'CORPORATE_ACTIONS_CONFIRMED_THROUGH',
    'REQUIRE_CORPORATE_ACTION_CONFIRMATION',
  ]) delete process.env[key];
}

test.beforeEach(() => {
  resetEnv();
  clear('../netlify/lib/portfolio-policy');
  clear('../netlify/lib/fundamental-scorecard');
  clear('../netlify/lib/market-calendar');
  clear('../netlify/lib/corporate-action-gate');
  clear('../netlify/functions/autotrade');
});

test('portfolio policy uses 60 core 20 active 20 tactical cash', () => {
  const { loadPortfolioPolicy } = require('../netlify/lib/portfolio-policy');
  const policy = loadPortfolioPolicy();
  assert.equal(policy.targets.CORE, 0.60);
  assert.equal(policy.targets.ACTIVE, 0.20);
  assert.equal(policy.targets.CASH, 0.20);
  assert.equal(policy.targets.REVIEW, 0);
});

test('unknown symbols are REVIEW and cannot create orders', () => {
  const { classifySymbol, orderEligibility } = require('../netlify/lib/portfolio-policy');
  assert.equal(classifySymbol('UNKNOWN'), 'REVIEW');
  assert.deepEqual(orderEligibility({ symbol: 'UNKNOWN', action: 'BUY' }), {
    eligible: false,
    bucket: 'REVIEW',
    reason: 'REVIEW_BUCKET_NO_ORDERS',
  });
});

test('CORE order requires complete evidence, not AI score', () => {
  process.env.CORE_SYMBOLS = 'TEST';
  clear('../netlify/lib/portfolio-policy');
  const { orderEligibility } = require('../netlify/lib/portfolio-policy');

  assert.equal(orderEligibility({
    symbol: 'TEST',
    action: 'CORE_BUY_CANDIDATE',
    evidence: { fundamentalPassed: true },
  }).eligible, false);

  const approved = orderEligibility({
    symbol: 'TEST',
    action: 'CORE_BUY_CANDIDATE',
    evidence: {
      fundamentalPassed: true,
      thesisApproved: true,
      valuationPassed: true,
      corporateActionClear: true,
      cashReserveMaintained: true,
    },
  });
  assert.equal(approved.eligible, true);
  assert.equal(approved.reason, 'CORE_EVIDENCE_APPROVED');
});

function strongSnapshot(overrides = {}) {
  const annuals = [2021, 2022, 2023, 2024, 2025].map((year, index) => ({
    year,
    revenue: 1000 + index * 100,
    netIncome: 100 + index * 10,
    eps: 1 + index * 0.1,
    roePct: 15,
    roaPct: 7,
    debtToEquity: 0.6,
    interestCoverage: 8,
    operatingCashFlow: 140 + index * 10,
    freeCashFlow: 90 + index * 8,
    retainedEarnings: 500 + index * 50,
    dividendPerShare: 0.6,
    payoutRatioPct: 50,
  }));
  return {
    symbol: 'TEST',
    sectorProfile: 'GENERAL',
    asOf: '2026-06-30',
    auditOpinion: 'UNQUALIFIED OPINION',
    market: {
      price: 10,
      pe: 12,
      ownMedianPe: 14,
      sectorMedianPe: 15,
      dividendYieldPct: 5.5,
    },
    annuals,
    manualEvidence: {},
    ...overrides,
  };
}

test('quality dividend value scorecard passes strong fundamentals', () => {
  const { evaluateFundamentals } = require('../netlify/lib/fundamental-scorecard');
  const result = evaluateFundamentals(strongSnapshot());
  assert.equal(result.passed, true);
  assert.equal(result.status, 'PASS');
  assert.equal(result.hardFailures.length, 0);
});

test('high dividend yield cannot hide weak free cash flow', () => {
  const { evaluateFundamentals } = require('../netlify/lib/fundamental-scorecard');
  const snapshot = strongSnapshot();
  snapshot.market.dividendYieldPct = 9;
  snapshot.annuals = snapshot.annuals.map((row, index) => ({
    ...row,
    freeCashFlow: index < 3 ? -50 : 10,
  }));
  const result = evaluateFundamentals(snapshot);
  assert.equal(result.passed, false);
  assert.ok(result.hardFailures.includes('FREE_CASH_FLOW_HISTORY'));
});

test('price decline alone never authorizes averaging down', () => {
  const { evaluateAveragingDown } = require('../netlify/lib/fundamental-scorecard');
  const result = evaluateAveragingDown({
    currentSnapshot: strongSnapshot(),
    previousSnapshot: strongSnapshot(),
    thesisApproval: { approved: false, reason: 'THESIS_NOT_APPROVED' },
    currentPrice: 8,
    lastTranchePrice: 10,
    currentPositionWeight: 0.05,
    maxPositionWeight: 0.12,
    valuationPassed: true,
    freshFundamentals: true,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('THESIS_NOT_APPROVED'));
});

test('SET holiday calendar blocks 29 July 2026', () => {
  const { isSetTradingDay } = require('../netlify/lib/market-calendar');
  const result = isSetTradingDay(new Date('2026-07-29T03:00:00.000Z'));
  assert.equal(result.openDay, false);
  assert.equal(result.reason, 'SET_HOLIDAY');
});

test('corporate action status is fail-closed until confirmed', () => {
  const { corporateActionGate } = require('../netlify/lib/corporate-action-gate');
  const result = corporateActionGate({
    symbol: 'TEST',
    date: '2026-08-03',
    researchEvents: [],
    env: {},
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'CORPORATE_ACTION_STATUS_UNCONFIRMED');
});

test('official SET factsheet parser extracts market ratios without inventing missing data', () => {
  const { parseFactsheetHtml } = require('../netlify/lib/set-fundamental-data');
  const result = parseFactsheetHtml(`
    <h1>TEST</h1>
    <div>As of 27 Jul 2026</div>
    <h2>Business Type</h2><div>Produces essential industrial components.</div>
    <div>Paid-up (M.Baht) 100</div>
    <div>Market Cap (M.Baht) 1,200</div>
    <div>EV/EBITDA 5.20</div>
    <div>Price (Baht) 10.00</div>
    <div>P/E (X) 12.50</div>
    <div>P/BV (X) 1.10</div>
    <div>Latest Type of Report Unqualified opinion</div>
    <div>F/S Year Ended 31 Dec</div>
  `, 'TEST');
  assert.equal(result.market.price, 10);
  assert.equal(result.market.pe, 12.5);
  assert.equal(result.market.pbv, 1.1);
  assert.equal(result.auditOpinion.toLowerCase(), 'unqualified opinion');
});

test('AI scheduler is advisory-only and reports zero order intents', () => {
  const { _test } = require('../netlify/functions/autotrade');
  const result = _test.summarizeAdvisory({
    orders_placed: [{ orderId: 'SIMULATE', sym: 'TEST', side: 'Sell', qty: 100, mkt: 10 }],
    orders_failed: [],
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].authority, 'ADVISORY_ONLY');
});

test('shadow evidence gate requires both 20 days and 100 decisions', () => {
  const { evaluateShadowGate } = require('../netlify/lib/shadow-performance-store');
  const reports = Array.from({ length: 20 }, (_, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    marketOpenDay: true,
    decisionEvents: 5,
    duplicateIntentAttempts: 0,
    unauthorizedExecutionAttempts: 0,
    dataQualityFailures: 0,
    shadowTradeEvents: index < 10 ? 1 : 0,
    initialCapital: 100000,
    equity: 100000 + (index * 200),
    maxDrawdown: -0.03,
    setTriValue: 1000 + index,
  }));
  const gate = evaluateShadowGate(reports, {
    minimumDays: 20,
    minimumEvents: 100,
    minimumTradeEvents: 10,
    maximumDrawdown: -0.10,
  });
  assert.equal(gate.passed, true);
});

test('shadow evidence gate fails on data errors, no trades, loss or benchmark underperformance', () => {
  const { evaluateShadowGate } = require('../netlify/lib/shadow-performance-store');
  const reports = Array.from({ length: 20 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}`,
    marketOpenDay: true,
    decisionEvents: 5,
    duplicateIntentAttempts: 0,
    unauthorizedExecutionAttempts: 0,
    dataQualityFailures: index === 4 ? 1 : 0,
    shadowTradeEvents: 0,
    initialCapital: 100000,
    equity: 100000 - (index * 100),
    maxDrawdown: -0.12,
    setTriValue: 1000 + (index * 2),
  }));
  const gate = evaluateShadowGate(reports, {
    minimumDays: 20,
    minimumEvents: 100,
    minimumTradeEvents: 10,
    maximumDrawdown: -0.10,
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.checks.zeroDataQualityFailures, false);
  assert.equal(gate.checks.minimumTradeEvents, false);
  assert.equal(gate.checks.positiveAfterCostReturn, false);
  assert.equal(gate.checks.positiveBenchmarkExcess, false);
  assert.equal(gate.checks.drawdownWithinLimit, false);
});

test('technical breakout compares raw close with raw highs instead of mixing adjusted dividend prices', () => {
  const { evaluateActiveStrategy } = require('../netlify/lib/deterministic-strategy');
  const candles = Array.from({ length: 220 }, (_, index) => {
    const close = 10 + Math.sin(index / 3) * 0.2 + index * 0.002;
    return {
      time: 1700000000 + index * 86400,
      date: new Date((1700000000 + index * 86400) * 1000).toISOString().slice(0, 10),
      open: close - 0.02,
      high: close + 0.05,
      low: close - 0.05,
      close,
      adjustedClose: close * 0.8,
      volume: 1000000,
    };
  });
  const result = evaluateActiveStrategy(candles, {
    minimumBars: 220,
    maxAgeDays: 99999,
    now: new Date((candles.at(-1).time + 86400) * 1000),
    benchmarkRegime: { tradable: true },
  });
  assert.equal(result.features.close, candles.at(-1).close);
});
