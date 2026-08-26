const test = require('node:test');
const assert = require('node:assert/strict');

const { applySignals } = require('../netlify/lib/shadow-portfolio');

function initialState() {
  return {
    schemaVersion: 2,
    cash: 100000,
    equity: 100000,
    peakEquity: 100000,
    maxDrawdown: 0,
    positions: {},
    pendingSignals: {},
    trades: [],
  };
}

const prices = { TEST: 10 };
const volumes = { TEST: 1000000 };

test('shadow signal is queued and cannot fill at the same closing price', () => {
  const dayOne = applySignals(initialState(), [{
    symbol: 'TEST', action: 'BUY_CANDIDATE', price: 10,
    reasonCodes: ['BREAKOUT'], ruleVersion: 'TEST',
  }], {
    date: '2026-08-03', priceMap: prices,
    executionPriceMap: { TEST: 9.8 }, volumeMap: volumes,
    maxPositionWeight: 0.05, boardLot: 100,
  });

  assert.equal(dayOne.state.positions.TEST, undefined);
  assert.equal(dayOne.state.pendingSignals.TEST.action, 'BUY_CANDIDATE');
  assert.equal(dayOne.events.some((row) => row.side === 'BUY'), false);
});

test('queued shadow signal fills only on a later session open with liquidity checks', () => {
  const queued = applySignals(initialState(), [{
    symbol: 'TEST', action: 'BUY_CANDIDATE', price: 10,
    reasonCodes: ['BREAKOUT'], ruleVersion: 'TEST',
  }], {
    date: '2026-08-03', priceMap: prices,
    executionPriceMap: { TEST: 9.8 }, volumeMap: volumes,
    maxPositionWeight: 0.05, boardLot: 100,
  }).state;

  const dayTwo = applySignals(queued, [{
    symbol: 'TEST', action: 'HOLD', price: 11,
    reasonCodes: [], ruleVersion: 'TEST',
  }], {
    date: '2026-08-04', priceMap: { TEST: 11 },
    executionPriceMap: { TEST: 11 }, volumeMap: volumes,
    maxPositionWeight: 0.05, boardLot: 100,
  });

  assert.equal(dayTwo.state.pendingSignals.TEST, undefined);
  assert.equal(dayTwo.state.positions.TEST.entryPrice, 11);
  assert.equal(dayTwo.events.filter((row) => row.side === 'BUY').length, 1);
});
