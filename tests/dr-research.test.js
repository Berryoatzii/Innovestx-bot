const test = require('node:test');
const assert = require('node:assert/strict');

const universe = require('../config/research-universe-dr-pilot-2026.json');
const { _test: marketDataTest } = require('../netlify/lib/research-market-data');
const { buildThbBenchmark } = require('../tools/run-dr-research');

test('DR pilot universe is diversified, exact-symbol and research-only', () => {
  assert.equal(universe.authority, 'RESEARCH_ONLY_NO_ORDERS');
  assert.equal(universe.boardLot, 1);
  assert.ok(universe.instruments.length >= 5);
  assert.equal(new Set(universe.instruments.map((row) => row.symbol)).size, universe.instruments.length);
  for (const row of universe.instruments) {
    assert.match(row.symbol, /^[A-Z0-9]{2,10}$/);
    assert.match(row.officialUrl, /^https:\/\/www\.set\.or\.th\//);
    assert.match(row.benchmark, /^[A-Z.]{2,12}$/);
    assert.ok(['INDEX_ETF', 'BOND_ETF', 'GOLD_ETF'].includes(row.exposure));
    assert.notEqual(row.exposure, 'SINGLE_STOCK');
  }
});

test('research market data accepts only the explicit Yahoo FX ticker form', () => {
  assert.equal(marketDataTest.normalizeSymbol('THB=X'), 'THB=X');
  assert.throws(() => marketDataTest.normalizeSymbol('THB=Y'), /INVALID_RESEARCH_SYMBOL/);
  assert.throws(() => marketDataTest.normalizeSymbol('USDTHB=X'), /INVALID_RESEARCH_SYMBOL/);
});

test('THB benchmark is aligned by date without forward-filling missing FX', () => {
  const benchmark = [
    { date: '2026-01-02', time: 1, open: 100, high: 102, low: 99, close: 101, adjustedClose: 101, volume: 10 },
    { date: '2026-01-03', time: 2, open: 101, high: 103, low: 100, close: 102, adjustedClose: 102, volume: 12 },
  ];
  const fx = [
    { date: '2026-01-02', close: 35 },
  ];
  const result = buildThbBenchmark(benchmark, fx);
  assert.equal(result.length, 1);
  assert.equal(result[0].close, 3535);
  assert.equal(result[0].adjustedClose, 3535);
});
