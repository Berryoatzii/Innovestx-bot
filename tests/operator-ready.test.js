const test = require('node:test');
const assert = require('node:assert/strict');

function clear(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; } catch {}
}

function resetEnv() {
  for (const name of [
    'ORDER_INTENT_GATE_SECRET',
    'CORE_TARGET_WEIGHT',
    'ACTIVE_TARGET_WEIGHT',
    'CASH_TARGET_WEIGHT',
    'CORE_SYMBOLS',
    'ACTIVE_SYMBOLS',
    'REVIEW_SYMBOLS',
  ]) delete process.env[name];
}

test.beforeEach(() => {
  resetEnv();
  clear('../netlify/lib/portfolio-policy');
  clear('../netlify/lib/portfolio-classification-store');
  clear('../netlify/lib/order-intent-store');
  clear('../netlify/lib/research-results-store');
  clear('../netlify/functions/invx');
  clear('../netlify/functions/rules-proposals');
});

test('portfolio targets include 60 core 20 active and 20 cash exactly', () => {
  const { loadPortfolioPolicy } = require('../netlify/lib/portfolio-policy');
  const policy = loadPortfolioPolicy({});
  assert.equal(policy.targets.CORE, 0.60);
  assert.equal(policy.targets.ACTIVE, 0.20);
  assert.equal(policy.targets.CASH, 0.20);
  assert.equal(policy.targets.REVIEW, 0);
  assert.equal(policy.targets.CORE + policy.targets.ACTIVE + policy.targets.CASH + policy.targets.REVIEW, 1);
});

test('historical list is only a bucket suggestion and defaults unknown symbols to REVIEW', () => {
  const { suggestBucket } = require('../netlify/lib/portfolio-classification-store');
  assert.equal(suggestBucket('TCAP').bucket, 'CORE');
  assert.equal(suggestBucket('BIS').bucket, 'ACTIVE');
  assert.equal(suggestBucket('UNKNOWN').bucket, 'REVIEW');
});

test('classification summary distinguishes explicit REVIEW from unclassified positions', () => {
  const { summarizeClassifications } = require('../netlify/lib/portfolio-classification-store');
  const portfolio = [{ sym: 'AAA' }, { sym: 'BBB' }];
  const map = {
    AAA: { symbol: 'AAA', bucket: 'REVIEW', explicit: true },
  };
  const summary = summarizeClassifications(portfolio, map);
  assert.equal(summary.counts.REVIEW, 2);
  assert.equal(summary.counts.UNCLASSIFIED, 1);
  assert.equal(summary.complete, false);
});

test('BUY proposal sizing respects cash reserve, max value and board lot', () => {
  const { calculateBuyProposalQuantity } = require('../netlify/lib/order-intent-store');
  assert.equal(calculateBuyProposalQuantity({
    cash: 10000,
    cashReserve: 5000,
    price: 12,
    maxOrderValue: 3000,
    boardLot: 100,
  }), 200);

  assert.equal(calculateBuyProposalQuantity({
    cash: 5500,
    cashReserve: 5000,
    price: 12,
    maxOrderValue: 3000,
    boardLot: 100,
  }), 0);
});

test('BUY intent is allowed with zero existing quantity while full SELL remains blocked', () => {
  const { buildIntent } = require('../netlify/lib/order-intent-store');
  const buy = buildIntent({
    idempotencyKey: 'buy-test',
    symbol: 'TEST',
    side: 'BUY',
    quantity: 100,
    proposedPrice: 10,
    portfolioQty: 0,
    portfolioBucket: 'ACTIVE',
  });
  assert.equal(buy.side, 'BUY');
  assert.equal(buy.portfolioQty, 0);

  assert.throws(() => buildIntent({
    idempotencyKey: 'sell-test',
    symbol: 'TEST',
    side: 'SELL',
    quantity: 100,
    proposedPrice: 10,
    portfolioQty: 100,
    portfolioBucket: 'ACTIVE',
  }), /FULL_POSITION_EXIT_NOT_ALLOWED/);
});

test('backtest gate requires after-cost return, benchmark edge, decisions and controlled drawdown', () => {
  const { evaluateBacktestGate } = require('../netlify/lib/research-results-store');
  const passing = evaluateBacktestGate({
    metrics: {
      completedTrades: 8,
      totalReturn: 0.18,
      excessVsBenchmark: 0.05,
      maxDrawdown: -0.12,
      cagr: 0.09,
    },
    robustness: { passed: true },
    decisionLog: new Array(300).fill({}),
  });
  assert.equal(passing.passed, true);

  const failing = evaluateBacktestGate({
    metrics: {
      completedTrades: 8,
      totalReturn: 0.18,
      excessVsBenchmark: -0.05,
      maxDrawdown: -0.12,
      cagr: 0.09,
    },
    robustness: { passed: true },
    decisionLog: new Array(300).fill({}),
  });
  assert.equal(failing.passed, false);
  assert.equal(failing.checks.beatsBenchmark, false);
});

test('backtest gate fails closed without explicit stress evidence', () => {
  const { evaluateBacktestGate } = require('../netlify/lib/research-results-store');
  const result = evaluateBacktestGate({
    metrics: {
      completedTrades: 8,
      totalReturn: 0.18,
      excessVsBenchmark: 0.05,
      maxDrawdown: -0.12,
      cagr: 0.09,
    },
    decisionLog: new Array(300).fill({}),
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.robustnessPassed, false);
});

test('order signature changes when symbol side quantity or price changes', () => {
  process.env.ORDER_INTENT_GATE_SECRET = 'test-secret';
  clear('../netlify/functions/invx');
  const { _test } = require('../netlify/functions/invx');
  const base = _test.expectedIntentSignature('0123456789abcdef', {
    ticker: 'TEST', side: 'Buy', quantity: 100, price: 10,
  });
  const changedQuantity = _test.expectedIntentSignature('0123456789abcdef', {
    ticker: 'TEST', side: 'Buy', quantity: 200, price: 10,
  });
  const changedPrice = _test.expectedIntentSignature('0123456789abcdef', {
    ticker: 'TEST', side: 'Buy', quantity: 100, price: 10.5,
  });
  assert.notEqual(base, changedQuantity);
  assert.notEqual(base, changedPrice);
});

test('rules proposal session separates morning and afternoon idempotency windows', () => {
  const { _test } = require('../netlify/functions/rules-proposals');
  assert.equal(_test.sessionName(new Date('2026-08-03T03:15:00.000Z')), 'AM');
  assert.equal(_test.sessionName(new Date('2026-08-03T07:15:00.000Z')), 'PM');
});
