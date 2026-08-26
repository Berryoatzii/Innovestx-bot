const test = require('node:test');
const assert = require('node:assert/strict');

const {
  simulateDailyExecution,
} = require('../netlify/lib/execution-realism');

test('execution rejects an order that exceeds the configured daily-volume participation', () => {
  const result = simulateDailyExecution({
    side: 'BUY',
    requestedQuantity: 1000,
    referencePrice: 10,
    dailyVolume: 5000,
    boardLot: 100,
    maxParticipationRate: 0.01,
  });

  assert.equal(result.filled, false);
  assert.equal(result.reason, 'LIQUIDITY_LIMIT');
  assert.equal(result.maximumQuantity, 0);
});

test('execution accepts a board-lot order within the liquidity cap and adds market impact', () => {
  const result = simulateDailyExecution({
    side: 'SELL',
    requestedQuantity: 100,
    referencePrice: 10,
    dailyVolume: 100000,
    boardLot: 100,
    maxParticipationRate: 0.01,
    impactBpsAtMaxParticipation: 30,
    costModel: {
      commissionRate: 0.0015,
      setTradingFeeRate: 0.00005,
      clearingFeeRate: 0.00001,
      regulatoryFeeRate: 0.00001,
      vatRate: 0.07,
      slippageBpsPerSide: 10,
      minimumCommissionPerDay: 0,
    },
  });

  assert.equal(result.filled, true);
  assert.equal(result.quantity, 100);
  assert.equal(result.participationRate, 0.001);
  assert.ok(result.costs.marketImpact > 0);
  assert.ok(result.costs.total > result.costs.slippage);
});

test('execution fails closed when volume data is absent', () => {
  const result = simulateDailyExecution({
    side: 'BUY',
    requestedQuantity: 100,
    referencePrice: 10,
    dailyVolume: 0,
    boardLot: 100,
  });

  assert.equal(result.filled, false);
  assert.equal(result.reason, 'VOLUME_UNAVAILABLE');
});

test('backtest records liquidity rejection and does not invent a fill', () => {
  const { backtestActiveStrategy } = require('../netlify/lib/backtest-engine');
  const candles = Array.from({ length: 225 }, (_, index) => ({
    time: 1700000000 + index * 86400,
    date: new Date((1700000000 + index * 86400) * 1000).toISOString().slice(0, 10),
    open: 10,
    high: 10.2,
    low: 9.8,
    close: 10,
    adjustedClose: 10,
    volume: index === 221 ? 5000 : 100000,
  }));
  const signalEvaluator = (history, options) => ({
    action: !options.hasPosition && history.length === 221 ? 'BUY_CANDIDATE' : 'NO_TRADE',
    reasonCodes: ['TEST_SIGNAL'],
    ruleVersion: 'TEST',
  });
  const benchmarkEvaluator = () => ({ tradable: true, reason: 'TEST' });

  const result = backtestActiveStrategy(candles, candles, {
    initialCapital: 100000,
    maxPositionWeight: 0.10,
    boardLot: 100,
    signalEvaluator,
    benchmarkEvaluator,
    maxParticipationRate: 0.01,
  });

  assert.equal(result.trades.length, 0);
  assert.ok(result.metrics.liquidityRejectedOrders > 0);
  assert.ok(result.decisionLog.some((row) => row.executionReason === 'LIQUIDITY_LIMIT'));
});

test('stress matrix makes elevated trading friction explicit', () => {
  const { runBacktestStressMatrix } = require('../netlify/lib/backtest-engine');
  const candles = Array.from({ length: 224 }, (_, index) => {
    const price = index < 221 ? 10 : index === 221 ? 10 : 11;
    return {
      time: 1700000000 + index * 86400,
      date: new Date((1700000000 + index * 86400) * 1000).toISOString().slice(0, 10),
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      adjustedClose: price,
      volume: 10000000,
    };
  });
  const signalEvaluator = (history, options) => ({
    action: history.length === 221 && !options.hasPosition
      ? 'BUY_CANDIDATE'
      : history.length === 222 && options.hasPosition
        ? 'EXIT_REVIEW'
        : 'NO_TRADE',
    reasonCodes: ['TEST_SIGNAL'],
    ruleVersion: 'TEST',
  });

  const result = runBacktestStressMatrix(candles, candles, {
    initialCapital: 100000,
    maxPositionWeight: 0.10,
    boardLot: 100,
    signalEvaluator,
    benchmarkEvaluator: () => ({ tradable: true, reason: 'TEST' }),
  });

  assert.equal(result.scenarios.length, 3);
  assert.ok(result.scenarios.every((row) => Number.isFinite(row.metrics.totalReturn)));
  assert.ok(result.scenarios[2].metrics.totalReturn <= result.scenarios[0].metrics.totalReturn);
  assert.equal(typeof result.passed, 'boolean');
});

test('single-position backtest compares against a benchmark with the same capital weight', () => {
  const { backtestActiveStrategy } = require('../netlify/lib/backtest-engine');
  const candles = Array.from({ length: 224 }, (_, index) => ({
    time: 1700000000 + index * 86400,
    date: new Date((1700000000 + index * 86400) * 1000).toISOString().slice(0, 10),
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    adjustedClose: 10,
    volume: 10000000,
  }));
  const benchmark = candles.map((row, index) => ({
    ...row,
    close: index === candles.length - 1 ? 11 : 10,
    adjustedClose: index === candles.length - 1 ? 11 : 10,
  }));
  const result = backtestActiveStrategy(candles, benchmark, {
    initialCapital: 100000,
    maxPositionWeight: 0.05,
    signalEvaluator: () => ({ action: 'NO_TRADE', reasonCodes: [], ruleVersion: 'TEST' }),
    benchmarkEvaluator: () => ({ tradable: true }),
  });

  assert.ok(Math.abs(result.metrics.benchmarkReturn - 0.1) < 1e-12);
  assert.ok(Math.abs(result.metrics.benchmarkPortfolioReturn - 0.005) < 1e-12);
  assert.ok(Math.abs(result.metrics.excessVsBenchmark + 0.005) < 1e-12);
});

test('recent holdout validation is reported separately from the full sample', () => {
  const { runBacktestValidationSuite } = require('../netlify/lib/backtest-engine');
  const candles = Array.from({ length: 800 }, (_, index) => {
    const price = 10 + index * 0.001;
    return {
      time: 1600000000 + index * 86400,
      date: new Date((1600000000 + index * 86400) * 1000).toISOString().slice(0, 10),
      open: price,
      high: price + 0.1,
      low: price - 0.1,
      close: price,
      adjustedClose: price,
      volume: 10000000,
    };
  });
  const suite = runBacktestValidationSuite(candles, candles, {
    signalEvaluator: () => ({ action: 'NO_TRADE', reasonCodes: [], ruleVersion: 'TEST' }),
    benchmarkEvaluator: () => ({ tradable: true }),
    oosBars: 252,
  });

  assert.equal(suite.fullSample.scenarios.length, 3);
  assert.equal(suite.recentHoldout.scenarios.length, 3);
  assert.equal(suite.recentHoldout.startDate, candles[548].date);
  assert.equal(typeof suite.passed, 'boolean');
});
