const test = require('node:test');
const assert = require('node:assert/strict');

test('official SET50 research universe has 50 unique symbols and expires', () => {
  const universe = require('../config/research-universe-set50-h2-2026.json');
  assert.equal(universe.symbols.length, 50);
  assert.equal(new Set(universe.symbols).size, 50);
  assert.equal(universe.validFrom, '2026-07-01');
  assert.equal(universe.validThrough, '2026-12-31');
  assert.match(universe.sourceUrl, /^https:\/\/media\.set\.or\.th\//);
  assert.match(universe.usage, /never authorizes an order/i);
});
