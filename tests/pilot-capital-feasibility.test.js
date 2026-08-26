const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluatePilotCapital, isFullyPaidCashAccountType } = require('../netlify/lib/pilot-capital-feasibility');

test('Settrade cash-balance account variants are recognized without accepting credit accounts', () => {
  assert.equal(isFullyPaidCashAccountType('CASH_BALANCE'), true);
  assert.equal(isFullyPaidCashAccountType('CASH_BALANCE_FOR_TURNOVERLIST'), true);
  assert.equal(isFullyPaidCashAccountType('CASH_ACCOUNT'), false);
  assert.equal(isFullyPaidCashAccountType('CREDIT_BALANCE'), false);
});

const zeroFixedFeeModel = {
  commissionRate: 0.0015,
  setTradingFeeRate: 0.00005,
  clearingFeeRate: 0.00001,
  regulatoryFeeRate: 0.00001,
  vatRate: 0.07,
  slippageBpsPerSide: 10,
  minimumCommissionPerDay: 0,
};

function completeInput(overrides = {}) {
  return {
    capital: 3500,
    price: 1.90,
    stopPrice: 1.80,
    boardLot: 100,
    tickSize: 0.01,
    maxPositionWeight: 0.05,
    riskPerTradePct: 0.005,
    cashReserveWeight: 0.20,
    feesVerified: true,
    protectionVerified: true,
    costModel: zeroFixedFeeModel,
    ...overrides,
  };
}

test('fails closed when one board lot exceeds the active position cap', () => {
  const result = evaluatePilotCapital(completeInput());

  assert.equal(result.passed, false);
  assert.equal(result.minimumOrderValue, 190);
  assert.equal(result.maxPositionValue, 175);
  assert.equal(result.minimumRequiredCapital, 3800);
  assert.deepEqual(result.blockers, ['PILOT_BOARD_LOT_EXCEEDS_POSITION_CAP']);
  assert.ok(result.plannedLossAtStop < result.maxPlannedLoss);
});

test('passes only when a board lot fits beneath the configured position cap', () => {
  const result = evaluatePilotCapital(completeInput({ capital: 10000 }));

  assert.equal(result.passed, true);
  assert.equal(result.minimumOrderValue, 190);
  assert.equal(result.maxPositionValue, 500);
  assert.equal(result.minimumRequiredCapital, 3800);
  assert.deepEqual(result.blockers, []);
});

test('invalid or missing market inputs fail closed without fabricating affordability', () => {
  const result = evaluatePilotCapital(completeInput({ price: null }));

  assert.equal(result.passed, false);
  assert.equal(result.minimumOrderValue, null);
  assert.deepEqual(result.blockers, ['PILOT_PRICE_UNAVAILABLE']);
});

test('fixed daily fees can exhaust the entire risk budget before price loss', () => {
  const result = evaluatePilotCapital(completeInput({
    price: 1.50,
    stopPrice: 1.49,
    costModel: {
      ...zeroFixedFeeModel,
      commissionRate: 0.002,
      setTradingFeeRate: 0,
      clearingFeeRate: 0,
      regulatoryFeeRate: 0,
      slippageBpsPerSide: 0,
      minimumCommissionPerDay: 14,
    },
  }));

  assert.equal(result.passed, false);
  assert.equal(result.roundTripCosts, 29.96);
  assert.ok(result.blockers.includes('PILOT_PLANNED_LOSS_EXCEEDS_RISK_BUDGET'));
});

test('unverified fees or exit protection fail closed', () => {
  const result = evaluatePilotCapital(completeInput({
    feesVerified: false,
    protectionVerified: false,
  }));

  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('PILOT_FEES_UNVERIFIED'));
  assert.ok(result.blockers.includes('PILOT_PROTECTION_UNVERIFIED'));
});

test('malformed cost models cannot create a false affordability pass', () => {
  const result = evaluatePilotCapital(completeInput({ costModel: {} }));

  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('PILOT_COST_MODEL_INVALID'));
  assert.equal(result.plannedLossAtStop, undefined);
});

test('one-unit DR board lots can fit a 3500 baht pilot when every other gate passes', () => {
  const result = evaluatePilotCapital(completeInput({
    price: 34.75,
    stopPrice: 34.50,
    boardLot: 1,
    tickSize: 0.25,
  }));

  assert.equal(result.passed, true);
  assert.equal(result.minimumOrderValue, 34.75);
  assert.ok(result.plannedLossAtStop <= 17.50);
});

test('fully-paid long-only DR can cap risk by losing the entire notional without relying on a stop', () => {
  const result = evaluatePilotCapital(completeInput({
    price: 3.22,
    stopPrice: null,
    boardLot: 1,
    tickSize: 0.01,
    protectionMode: 'FULL_NOTIONAL_LONG_ONLY',
    accountType: 'CASH_BALANCE',
    longOnly: true,
    fullyPaid: true,
    protectionVerified: false,
  }));

  assert.equal(result.passed, true);
  assert.equal(result.protectionMode, 'FULL_NOTIONAL_LONG_ONLY');
  assert.equal(result.minimumOrderValue, 3.22);
  assert.equal(result.plannedLossAtStop, null);
  assert.ok(result.worstCaseLossAtZero <= 17.50);
  assert.deepEqual(result.blockers, []);
});

test('full-notional protection fails closed unless the position is fully paid, long-only Cash Balance', () => {
  for (const overrides of [
    { accountType: 'CASH_ACCOUNT' },
    { fullyPaid: false },
    { longOnly: false },
    { accountType: true },
  ]) {
    const result = evaluatePilotCapital(completeInput({
      price: 3.22,
      stopPrice: null,
      boardLot: 1,
      tickSize: 0.01,
      protectionMode: 'FULL_NOTIONAL_LONG_ONLY',
      accountType: 'CASH_BALANCE',
      longOnly: true,
      fullyPaid: true,
      protectionVerified: false,
      ...overrides,
    }));
    assert.equal(result.passed, false);
    assert.ok(result.blockers.includes('PILOT_FULL_NOTIONAL_PROTECTION_INVALID'));
  }

  const malformedMode = evaluatePilotCapital(completeInput({
    price: 3.22,
    stopPrice: null,
    boardLot: 1,
    tickSize: 0.01,
    protectionMode: true,
    accountType: 'CASH_BALANCE',
    longOnly: true,
    fullyPaid: true,
  }));
  assert.equal(malformedMode.passed, false);
  assert.ok(malformedMode.blockers.includes('PILOT_PROTECTION_MODE_INVALID'));
});

test('minimum commissions can make even a one-unit full-notional pilot exceed its risk budget', () => {
  const result = evaluatePilotCapital(completeInput({
    price: 3.22,
    stopPrice: null,
    boardLot: 1,
    tickSize: 0.01,
    protectionMode: 'FULL_NOTIONAL_LONG_ONLY',
    accountType: 'CASH_BALANCE',
    longOnly: true,
    fullyPaid: true,
    protectionVerified: false,
    costModel: {
      ...zeroFixedFeeModel,
      minimumCommissionPerDay: 14,
    },
  }));

  assert.equal(result.passed, false);
  assert.ok(result.worstCaseLossAtZero > 17.50);
  assert.ok(result.blockers.includes('PILOT_FULL_NOTIONAL_LOSS_EXCEEDS_RISK_BUDGET'));
});
