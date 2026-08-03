const defaultPolicy = require('../../config/portfolio-policy.json');

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadCostModel(env = process.env, policy = defaultPolicy) {
  const base = policy.costModel || {};
  return {
    commissionRate: numberOr(env.COMMISSION_RATE, numberOr(base.commissionRate, 0.0015)),
    setTradingFeeRate: numberOr(env.SET_TRADING_FEE_RATE, numberOr(base.setTradingFeeRate, 0.00005)),
    clearingFeeRate: numberOr(env.CLEARING_FEE_RATE, numberOr(base.clearingFeeRate, 0.00001)),
    regulatoryFeeRate: numberOr(env.REGULATORY_FEE_RATE, numberOr(base.regulatoryFeeRate, 0.00001)),
    vatRate: numberOr(env.VAT_RATE, numberOr(base.vatRate, 0.07)),
    slippageBpsPerSide: numberOr(env.SLIPPAGE_BPS_PER_SIDE, numberOr(base.slippageBpsPerSide, 10)),
    minimumCommissionPerDay: numberOr(env.MINIMUM_COMMISSION_PER_DAY, numberOr(base.minimumCommissionPerDay, 0)),
  };
}

function transactionCost(notional, model = loadCostModel()) {
  const value = Math.max(0, Number(notional || 0));
  const commission = value * model.commissionRate;
  const exchangeFees = value * (
    model.setTradingFeeRate +
    model.clearingFeeRate +
    model.regulatoryFeeRate
  );
  const vat = (commission + exchangeFees) * model.vatRate;
  const slippage = value * (model.slippageBpsPerSide / 10000);
  return {
    notional: value,
    commission,
    exchangeFees,
    vat,
    slippage,
    total: commission + exchangeFees + vat + slippage,
  };
}

function roundTripCost(entryNotional, exitNotional, model = loadCostModel()) {
  const entry = transactionCost(entryNotional, model);
  const exit = transactionCost(exitNotional, model);
  return {
    entry,
    exit,
    total: entry.total + exit.total,
  };
}

function netTradeReturn({ entryPrice, exitPrice, quantity, model = loadCostModel() }) {
  const qty = Math.max(0, Number(quantity || 0));
  const entry = Math.max(0, Number(entryPrice || 0));
  const exit = Math.max(0, Number(exitPrice || 0));
  const entryNotional = entry * qty;
  const exitNotional = exit * qty;
  const costs = roundTripCost(entryNotional, exitNotional, model);
  const grossPnl = exitNotional - entryNotional;
  const netPnl = grossPnl - costs.total;
  return {
    quantity: qty,
    entryNotional,
    exitNotional,
    grossPnl,
    netPnl,
    netReturnPct: entryNotional > 0 ? netPnl / entryNotional : 0,
    costs,
  };
}

module.exports = {
  loadCostModel,
  transactionCost,
  roundTripCost,
  netTradeReturn,
};
