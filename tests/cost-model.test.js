const test = require('node:test');
const assert = require('node:assert/strict');

const { transactionCost, roundTripCost } = require('../netlify/lib/cost-model');

const minimumFeeModel = {
  commissionRate: 0.002,
  setTradingFeeRate: 0,
  clearingFeeRate: 0,
  regulatoryFeeRate: 0,
  vatRate: 0.07,
  slippageBpsPerSide: 0,
  minimumCommissionPerDay: 14,
};

test('minimum daily commission is charged before VAT', () => {
  const result = transactionCost(190, minimumFeeModel);

  assert.equal(result.commission, 14);
  assert.ok(Math.abs(result.vat - 0.98) < 1e-12);
  assert.ok(Math.abs(result.total - 14.98) < 1e-12);
});

test('round trip conservatively applies a daily minimum on both sides', () => {
  const result = roundTripCost(190, 180, minimumFeeModel);

  assert.equal(result.total, 29.96);
});
