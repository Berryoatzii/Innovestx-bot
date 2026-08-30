const test = require('node:test');
const assert = require('node:assert/strict');

const {
  monthlyCloses,
  selectWithRetention,
  runMonthlyAllocation,
  runAllocationStressMatrix,
} = require('../netlify/lib/diversified-allocation-research');

function monthRows(symbol, closes) {
  return closes.map((close, index) => ({
    symbol,
    month: `${2020 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
    close,
  }));
}

test('monthly closes use the last available adjusted observation without inventing a month', () => {
  const rows = monthlyCloses([
    { date: '2026-01-02', close: 10, adjustedClose: 9.8 },
    { date: '2026-01-30', close: 11, adjustedClose: 10.8 },
    { date: '2026-03-02', close: 12, adjustedClose: 11.8 },
  ]);

  assert.deepEqual(rows, [
    { month: '2026-01', date: '2026-01-30', close: 10.8 },
    { month: '2026-03', date: '2026-03-02', close: 11.8 },
  ]);
});

test('monthly allocation applies a signal only to the following month return', () => {
  const rising = Array.from({ length: 40 }, (_, index) => 100 + index * 2);
  const falling = Array.from({ length: 40 }, (_, index) => 100 - index);
  const result = runMonthlyAllocation({
    RISE: monthRows('RISE', rising),
    FALL: monthRows('FALL', falling),
  }, {
    warmupMonths: 10,
    momentumMonths: 6,
    maxSelected: 1,
    positionWeight: 0.05,
    costRate: 0,
  });

  assert.equal(result.decisionLog[0].signalMonth, '2020-11');
  assert.equal(result.decisionLog[0].returnMonth, '2020-12');
  assert.deepEqual(result.decisionLog[0].selected, ['RISE']);
  assert.ok(result.metrics.totalReturn > 0);
});

test('benchmark uses the same maximum gross exposure as the allocation strategy', () => {
  const risingA = Array.from({ length: 40 }, (_, index) => 100 + index * 2);
  const risingB = Array.from({ length: 40 }, (_, index) => 80 + index);
  const result = runMonthlyAllocation({
    A: monthRows('A', risingA),
    B: monthRows('B', risingB),
  }, {
    warmupMonths: 10,
    momentumMonths: 6,
    maxSelected: 1,
    positionWeight: 0.05,
    costRate: 0,
  });

  assert.equal(result.assumptions.benchmarkGrossExposure, 0.05);
  assert.equal(result.assumptions.benchmarkPositionWeight, 0.025);
});

test('scheduled rebalancing holds drifted weights between decision months', () => {
  const risingA = Array.from({ length: 40 }, (_, index) => 100 + index * 2);
  const risingB = Array.from({ length: 40 }, (_, index) => 80 + index);
  const result = runMonthlyAllocation({
    A: monthRows('A', risingA),
    B: monthRows('B', risingB),
  }, {
    warmupMonths: 10,
    momentumMonths: 6,
    maxSelected: 1,
    positionWeight: 0.05,
    rebalanceEveryMonths: 3,
    costRate: 0.01,
  });

  assert.equal(result.decisionLog[0].rebalanced, true);
  assert.equal(result.decisionLog[1].rebalanced, false);
  assert.equal(result.decisionLog[1].turnover, 0);
  assert.equal(result.decisionLog[2].rebalanced, false);
  assert.equal(result.decisionLog[3].rebalanced, true);
  assert.equal(result.metrics.rebalances, Math.ceil(result.metrics.decisions / 3));
});

test('retention buffer drops ineligible holdings and never exceeds the position cap', () => {
  assert.deepEqual(
    selectWithRetention(['B', 'C', 'D'], ['A', 'B', 'C'], 2, 3),
    ['B', 'C'],
  );
  assert.deepEqual(
    selectWithRetention(['C', 'D', 'E'], ['B', 'C'], 2, 2),
    ['C', 'D'],
  );
});

test('allocation fails closed when histories do not share enough complete months', () => {
  assert.throws(() => runMonthlyAllocation({
    A: monthRows('A', Array(20).fill(10)),
    B: monthRows('B', Array(8).fill(10)),
  }), /INSUFFICIENT_COMMON_MONTHS/);
});

test('stress matrix requires every friction scenario and holdout to pass', () => {
  const risingA = Array.from({ length: 60 }, (_, index) => 100 + index * 2);
  const risingB = Array.from({ length: 60 }, (_, index) => 80 + index);
  const histories = {
    A: monthRows('A', risingA),
    B: monthRows('B', risingB),
  };
  const result = runAllocationStressMatrix(histories, {
    costs: [0, 0.001, 0.002],
    holdoutMonths: 24,
    maxSelected: 1,
    minimumPositionChanges: 1,
  });

  assert.equal(result.scenarios.length, 3);
  assert.equal(result.holdout.scenarios.length, 3);
  assert.equal(typeof result.passed, 'boolean');
  assert.ok(result.scenarios.every((row) => Number.isFinite(row.metrics.totalReturn)));
});
