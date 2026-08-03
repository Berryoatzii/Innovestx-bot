const test = require('node:test');
const assert = require('node:assert/strict');

const {
  tickSize,
  roundToTick,
  valuationBand,
  quantityPlan,
  formatActionPlan,
} = require('../netlify/lib/portfolio-action-plan');

test('SET stock tick sizes follow market price bands', () => {
  assert.equal(tickSize(1.50), 0.01);
  assert.equal(tickSize(2.50), 0.02);
  assert.equal(tickSize(7.50), 0.05);
  assert.equal(tickSize(20), 0.10);
  assert.equal(tickSize(50), 0.25);
  assert.equal(tickSize(150), 0.50);
  assert.equal(tickSize(250), 1.00);
  assert.equal(tickSize(500), 2.00);
  assert.equal(roundToTick(7.53, 'up'), 7.55);
});

test('fair value is unavailable without verified complete fundamentals', () => {
  assert.deepEqual(valuationBand(null, 10), {
    available: false,
    reason: 'VERIFIED_FUNDAMENTAL_SNAPSHOT_REQUIRED',
  });
});

test('verified fair-value range is preserved and compared with market', () => {
  const result = valuationBand({
    verifiedAt: '2026-08-01T00:00:00.000Z',
    completeness: { ratio: 1 },
    asOf: '2026-06-30',
    market: { fairValueLow: 8.2, fairValueHigh: 10.4 },
    annuals: [],
  }, 7.5);

  assert.equal(result.available, true);
  assert.equal(result.low, 8.2);
  assert.equal(result.high, 10.4);
  assert.equal(result.status, 'BELOW_VALUE_RANGE');
});

test('REVIEW and healthy CORE positions cannot receive sell quantities', () => {
  const technical = { available: true, timing: 'REDUCE_ON_REBOUND', trendBroken: true };
  assert.equal(quantityPlan({
    bucket: 'REVIEW', quantity: 1000, technical, fundamentalBreak: { broken: false },
  }).first, 0);

  assert.equal(quantityPlan({
    bucket: 'CORE', quantity: 1000, technical, fundamentalBreak: { broken: false },
  }).first, 0);
});

test('ACTIVE sell plan is partial and never liquidates the full position', () => {
  const result = quantityPlan({
    bucket: 'ACTIVE',
    quantity: 1500,
    technical: { available: true, timing: 'REDUCE_ON_REBOUND', trendBroken: true },
    fundamentalBreak: { broken: false },
    boardLot: 100,
  });
  assert.equal(result.first, 300);
  assert.ok(result.second >= 0);
  assert.ok(result.first + result.second < 1500);
});

test('formatted plan includes market, quantity, value and chart timing', () => {
  const text = formatActionPlan({
    symbol: 'TEST',
    bucket: 'ACTIVE',
    classificationExplicit: true,
    suggestedBucket: 'ACTIVE',
    market: { current: 10, bid: 9.9, ask: 10.1 },
    position: { quantity: 1000, averageCost: 12, pnlPct: -16.67 },
    valuation: { available: true, low: 9, base: 10, high: 11, status: 'WITHIN_VALUE_RANGE', asOf: '2026-06-30' },
    technical: {
      available: true,
      ema20: 10.5,
      ema50: 11,
      rsi14: 39,
      macdHistogram: -0.12,
      atr14: 0.5,
      support1: 9.5,
      support2: 9,
      resistance1: 10.5,
      resistance2: 11,
      timing: 'REDUCE_ON_REBOUND',
      sellZoneLow: 10.5,
      sellZoneHigh: 11,
    },
    quantities: { first: 200, second: 200, reason: 'PARTIAL_EXIT_ONLY' },
    fundamentalBreak: { broken: false, reasons: [] },
    aiObservation: { reason: 'แนวโน้มอ่อนตัว', authority: 'ADVISORY_ONLY' },
  });

  assert.match(text, /ตลาดล่าสุด/);
  assert.match(text, /มูลค่าธุรกิจ/);
  assert.match(text, /ไม้ 1: 200 หุ้น/);
  assert.match(text, /แนวรับ/);
  assert.match(text, /แนวต้าน/);
});