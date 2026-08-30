const test = require('node:test');
const assert = require('node:assert/strict');
const { VARIANTS, evaluatorFor, benchmarkEvaluatorFor, _test } = require('../netlify/lib/research-strategy-variants');

function candles(length = 260) {
  return Array.from({ length }, (_, index) => {
    const close = 10 + (index * 0.03);
    return {
      time: 1700000000 + (index * 86400),
      date: new Date((1700000000 + (index * 86400)) * 1000).toISOString().slice(0, 10),
      open: close - 0.02,
      high: close + (index === length - 1 ? 0 : 0.02),
      low: close - 0.08,
      close,
      volume: index === length - 1 ? 1500000 : 1000000,
    };
  });
}

test('research variants are frozen and cannot claim production authority', () => {
  assert.equal(Object.isFrozen(VARIANTS), true);
  for (const id of Object.keys(VARIANTS)) {
    const result = evaluatorFor(id)(candles(), {
      minimumBars: 220,
      maxAgeDays: 99999,
      now: new Date((candles().at(-1).time + 86400) * 1000),
      benchmarkRegime: { tradable: true },
    });
    assert.equal(result.strategyAuthority, 'RESEARCH_ONLY');
    assert.equal(result.ruleVersion, id);
  }
});

test('turtle variant emits an entry only after a prior-high breakout', () => {
  const rows = candles();
  const result = evaluatorFor('TURTLE_55_20_V1')(rows, {
    minimumBars: 220,
    maxAgeDays: 99999,
    now: new Date((rows.at(-1).time + 86400) * 1000),
    benchmarkRegime: { tradable: true },
  });
  assert.equal(result.action, 'BUY_CANDIDATE');
});

test('rolling minimum excludes the current candle to avoid lookahead', () => {
  assert.equal(_test.rollingMin([5, 4, 3, 1], 3, 3), 3);
  assert.equal(_test.rollingMin([5, 4, 3, 1], 3, 4), 1);
});

test('unknown research variant fails closed', () => {
  assert.throws(() => evaluatorFor('UNKNOWN'), /UNKNOWN_RESEARCH_VARIANT/);
});

test('adaptive benchmark accepts a rising EMA50 recovery while preserving data validation', () => {
  const rows = candles();
  const result = benchmarkEvaluatorFor('ADAPTIVE_TREND_V1')(rows, {
    minimumBars: 220,
    maxAgeDays: 99999,
    now: new Date((rows.at(-1).time + 86400) * 1000),
  });
  assert.equal(result.tradable, true);
  assert.ok(['BENCHMARK_ABOVE_EMA200', 'BENCHMARK_RECOVERY_TREND'].includes(result.reason));
  assert.equal(result.ruleVersion, 'ADAPTIVE_TREND_V1');
});

test('unknown benchmark variant fails closed', () => {
  assert.throws(() => benchmarkEvaluatorFor('UNKNOWN'), /UNKNOWN_BENCHMARK_VARIANT/);
});
