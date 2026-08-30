const test = require('node:test');
const assert = require('node:assert/strict');

const {
  candidate,
  isCandidateDrIntent,
  isCandidateDrFullExit,
} = require('../netlify/lib/candidate-dr-controls');

function exactIntent(overrides = {}) {
  return {
    symbol: candidate.approvalScope.symbols[0],
    side: 'SELL',
    quantity: 7,
    portfolioQty: 7,
    portfolioBucket: 'ACTIVE',
    orderStyle: 'RESTING_LIMIT',
    candidateId: candidate.candidateId,
    strategyVersion: candidate.strategyVersion,
    instrumentType: 'DR',
    exitMode: 'FULL_POSITION',
    boardLot: 1,
    ...overrides,
  };
}

test('candidate DR controls accept only the exact scoped intent', () => {
  assert.equal(isCandidateDrIntent(exactIntent()), true);
  assert.equal(isCandidateDrFullExit(exactIntent(), 7), true);
});

test('candidate DR full exit fails closed on symbol, candidate, quantity or order-style drift', () => {
  for (const intent of [
    exactIntent({ symbol: 'TTB' }),
    exactIntent({ candidateId: 'OTHER' }),
    exactIntent({ quantity: 6 }),
    exactIntent({ portfolioQty: 8 }),
    exactIntent({ orderStyle: 'MARKETABLE_LIMIT' }),
    exactIntent({ instrumentType: 'EQUITY' }),
    exactIntent({ boardLot: 100 }),
  ]) assert.equal(isCandidateDrFullExit(intent, 7), false);
});
