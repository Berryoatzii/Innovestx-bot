const { roundTripCost } = require('./cost-model');

function positiveNumber(value) {
  if (typeof value === 'boolean' || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validFraction(value, { allowZero = false } = {}) {
  if (typeof value === 'boolean' || value === null || value === '') return null;
  const number = Number(value);
  const lowerBoundValid = allowZero ? number >= 0 : number > 0;
  return Number.isFinite(number) && lowerBoundValid && number <= 1 ? number : null;
}

function validCostModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
  const fields = [
    'commissionRate',
    'setTradingFeeRate',
    'clearingFeeRate',
    'regulatoryFeeRate',
    'vatRate',
    'slippageBpsPerSide',
    'minimumCommissionPerDay',
  ];
  return fields.every((key) => (
    typeof model[key] === 'number'
    && Number.isFinite(model[key])
    && model[key] >= 0
  )) && model.vatRate <= 1;
}

function tickAligned(price, tickSize) {
  const units = price / tickSize;
  return Math.abs(units - Math.round(units)) < 0.000001;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isFullyPaidCashAccountType(value) {
  return new Set([
    'CASH_BALANCE',
    'CASH_BALANCE_FOR_TURNOVERLIST',
  ]).has(String(value || '').trim().toUpperCase());
}

function evaluatePilotCapital(input = {}) {
  const protectionMode = input.protectionMode === undefined
    ? 'STOP_ORDER'
    : input.protectionMode;
  const fullNotionalMode = protectionMode === 'FULL_NOTIONAL_LONG_ONLY';
  const stopMode = protectionMode === 'STOP_ORDER';
  const capital = positiveNumber(input.capital);
  const price = positiveNumber(input.price);
  const stopPrice = positiveNumber(input.stopPrice);
  const boardLot = positiveNumber(input.boardLot);
  const tickSize = positiveNumber(input.tickSize);
  const maxPositionWeight = validFraction(input.maxPositionWeight);
  const riskPerTradePct = validFraction(input.riskPerTradePct);
  const cashReserveWeight = validFraction(input.cashReserveWeight, { allowZero: true });
  const blockers = [];

  if (capital === null) blockers.push('PILOT_CAPITAL_UNAVAILABLE');
  if (price === null) blockers.push('PILOT_PRICE_UNAVAILABLE');
  if (!stopMode && !fullNotionalMode) blockers.push('PILOT_PROTECTION_MODE_INVALID');
  if (stopMode && (stopPrice === null || (price !== null && stopPrice >= price))) {
    blockers.push('PILOT_STOP_INVALID');
  }
  if (boardLot === null || !Number.isInteger(boardLot)) blockers.push('PILOT_BOARD_LOT_INVALID');
  if (tickSize === null) blockers.push('PILOT_TICK_SIZE_INVALID');
  if (maxPositionWeight === null) blockers.push('PILOT_POSITION_CAP_INVALID');
  if (riskPerTradePct === null) blockers.push('PILOT_RISK_BUDGET_INVALID');
  if (cashReserveWeight === null || cashReserveWeight >= 1) blockers.push('PILOT_CASH_RESERVE_INVALID');
  if (input.feesVerified !== true) blockers.push('PILOT_FEES_UNVERIFIED');
  if (stopMode && input.protectionVerified !== true) blockers.push('PILOT_PROTECTION_UNVERIFIED');
  if (fullNotionalMode && !(
    isFullyPaidCashAccountType(input.accountType)
    && input.longOnly === true
    && input.fullyPaid === true
  )) blockers.push('PILOT_FULL_NOTIONAL_PROTECTION_INVALID');
  if (!input.costModel || typeof input.costModel !== 'object') blockers.push('PILOT_COST_MODEL_UNAVAILABLE');
  else if (!validCostModel(input.costModel)) blockers.push('PILOT_COST_MODEL_INVALID');
  if (
    price !== null && tickSize !== null
    && (
      !tickAligned(price, tickSize)
      || (stopMode && stopPrice !== null && !tickAligned(stopPrice, tickSize))
    )
  ) blockers.push('PILOT_PRICE_NOT_TICK_ALIGNED');

  if (blockers.length > 0) {
    return {
      passed: false,
      capital,
      protectionMode: typeof protectionMode === 'string' ? protectionMode : null,
      price,
      stopPrice,
      boardLot,
      tickSize,
      maxPositionWeight,
      riskPerTradePct,
      cashReserveWeight,
      minimumOrderValue: null,
      maxPositionValue: capital !== null && maxPositionWeight !== null
        ? roundMoney(capital * maxPositionWeight)
        : null,
      maxPlannedLoss: capital !== null && riskPerTradePct !== null
        ? roundMoney(capital * riskPerTradePct)
        : null,
      minimumRequiredCapital: null,
      blockers,
    };
  }

  const minimumOrderValue = roundMoney(price * boardLot);
  const maxPositionValue = roundMoney(capital * maxPositionWeight);
  const exitNotionalForCosts = fullNotionalMode
    ? price * boardLot
    : stopPrice * boardLot;
  const costs = roundTripCost(price * boardLot, exitNotionalForCosts, input.costModel);
  const roundTripCosts = roundMoney(costs.total);
  const plannedLossAtStop = stopMode
    ? roundMoney((price - stopPrice) * boardLot + costs.total)
    : null;
  const worstCaseLossAtZero = fullNotionalMode
    ? roundMoney(minimumOrderValue + costs.total)
    : null;
  const plannedRisk = fullNotionalMode ? worstCaseLossAtZero : plannedLossAtStop;
  const maxPlannedLoss = roundMoney(capital * riskPerTradePct);
  const entryCashRequired = roundMoney(price * boardLot + costs.entry.total);
  const maxInvestableCash = roundMoney(capital * (1 - cashReserveWeight));
  const minimumRequiredCapital = roundMoney(Math.max(
    minimumOrderValue / maxPositionWeight,
    plannedRisk / riskPerTradePct,
    entryCashRequired / (1 - cashReserveWeight),
  ));
  if (minimumOrderValue > maxPositionValue) {
    blockers.push('PILOT_BOARD_LOT_EXCEEDS_POSITION_CAP');
  }
  if (stopMode && plannedLossAtStop > maxPlannedLoss) {
    blockers.push('PILOT_PLANNED_LOSS_EXCEEDS_RISK_BUDGET');
  }
  if (fullNotionalMode && worstCaseLossAtZero > maxPlannedLoss) {
    blockers.push('PILOT_FULL_NOTIONAL_LOSS_EXCEEDS_RISK_BUDGET');
  }
  if (entryCashRequired > maxInvestableCash) {
    blockers.push('PILOT_CASH_RESERVE_BREACH');
  }

  return {
    passed: blockers.length === 0,
    capital,
    protectionMode,
    price,
    stopPrice,
    boardLot,
    tickSize,
    maxPositionWeight,
    riskPerTradePct,
    cashReserveWeight,
    minimumOrderValue,
    maxPositionValue,
    maxInvestableCash,
    entryCashRequired,
    roundTripCosts,
    plannedLossAtStop,
    worstCaseLossAtZero,
    maxPlannedLoss,
    minimumRequiredCapital,
    blockers,
  };
}

module.exports = { evaluatePilotCapital, isFullyPaidCashAccountType };
