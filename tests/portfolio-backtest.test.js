const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateScenarioRows } = require('../netlify/lib/portfolio-backtest');

function row(symbol, overrides = {}) {
  return {
    symbol,
    metrics: {
      totalReturn: 0.02,
      excessVsBenchmark: 0.01,
      maxDrawdown: -0.04,
      completedTrades: 5,
      liquidityRejectedOrders: 0,
      ...overrides,
    },
  };
}

test('portfolio aggregate can pass diversified after-cost evidence', () => {
  const result = aggregateScenarioRows([
    row('AAA'), row('BBB'), row('CCC', { totalReturn: -0.005, excessVsBenchmark: 0.002 }), row('DDD'),
  ], {
    expectedSymbols: 4,
    minimumTrades: 15,
    minimumTradeCoverage: 0.75,
    minimumWinningBreadth: 0.70,
  });
  assert.equal(result.passed, true);
  assert.equal(result.metrics.completedTrades, 20);
  assert.equal(result.metrics.winningBreadth, 0.75);
});

test('portfolio aggregate fails closed on missing data, weak breadth or liquidity rejection', () => {
  const result = aggregateScenarioRows([
    row('AAA', { totalReturn: 0.03, completedTrades: 5 }),
    row('BBB', { totalReturn: -0.02, completedTrades: 0, liquidityRejectedOrders: 1 }),
  ], {
    expectedSymbols: 4,
    minimumTrades: 5,
    minimumDataCoverage: 0.95,
    minimumTradeCoverage: 0.50,
    minimumWinningBreadth: 0.50,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.dataCoverage, false);
  assert.equal(result.checks.tradeCoverage, false);
  assert.equal(result.checks.zeroLiquidityRejections, false);
});

test('portfolio aggregate cannot pass with zero trades even when prices are flat', () => {
  const result = aggregateScenarioRows([
    row('AAA', { totalReturn: 0, excessVsBenchmark: 0, completedTrades: 0 }),
  ], { expectedSymbols: 1, minimumTrades: 1, minimumTradeCoverage: 0 });
  assert.equal(result.passed, false);
  assert.equal(result.checks.enoughTrades, false);
  assert.equal(result.checks.positiveAfterCosts, false);
  assert.equal(result.checks.positiveBenchmarkExcess, false);
});
