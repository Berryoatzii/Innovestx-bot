const { transactionCost, loadCostModel } = require('./cost-model');

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function markToMarket(state, priceMap) {
  let positionValue = 0;
  const positions = { ...(state.positions || {}) };
  for (const [symbol, position] of Object.entries(positions)) {
    const price = Number(priceMap[symbol] || position.lastPrice || position.entryPrice || 0);
    position.lastPrice = price;
    position.marketValue = round(position.quantity * price);
    position.unrealizedPnl = round((price - position.entryPrice) * position.quantity - Number(position.entryCosts || 0));
    positionValue += position.marketValue;
  }
  const equity = round(Number(state.cash || 0) + positionValue);
  const peakEquity = Math.max(Number(state.peakEquity || equity), equity);
  const drawdown = peakEquity > 0 ? equity / peakEquity - 1 : 0;
  return {
    ...state,
    positions,
    equity,
    peakEquity,
    maxDrawdown: Math.min(Number(state.maxDrawdown || 0), drawdown),
  };
}

function calculateShadowQuantity({ state, price, maxPositionWeight = 0.10, boardLot = 100 }) {
  const equity = Math.max(0, Number(state.equity || state.cash || 0));
  const cash = Math.max(0, Number(state.cash || 0));
  const px = Number(price || 0);
  const lot = Math.max(1, Math.floor(Number(boardLot || 100)));
  if (equity <= 0 || cash <= 0 || px <= 0) return 0;
  const budget = Math.min(cash, equity * Number(maxPositionWeight || 0));
  return Math.max(0, Math.floor((budget / px) / lot) * lot);
}

function applySignals(stateInput, evaluations, options = {}) {
  const model = options.costModel || loadCostModel();
  const maxPositionWeight = Number(options.maxPositionWeight || 0.10);
  const maxPositions = Math.max(1, Math.floor(Number(options.maxPositions || 4)));
  const boardLot = Math.max(1, Math.floor(Number(options.boardLot || 100)));
  const runDate = options.date || new Date().toISOString().slice(0, 10);
  let state = markToMarket({ ...stateInput, positions: { ...(stateInput.positions || {}) } }, options.priceMap || {});
  const events = [];

  for (const evaluation of evaluations) {
    const symbol = String(evaluation.symbol || '').toUpperCase();
    const price = Number(evaluation.price || evaluation.features?.close || 0);
    const existing = state.positions[symbol];

    if (evaluation.action === 'EXIT_REVIEW' && existing) {
      const notional = existing.quantity * price;
      const costs = transactionCost(notional, model);
      const netProceeds = notional - costs.total;
      const grossPnl = (price - existing.entryPrice) * existing.quantity;
      const netPnl = grossPnl - Number(existing.entryCosts || 0) - costs.total;
      state.cash = round(Number(state.cash || 0) + netProceeds);
      delete state.positions[symbol];
      const trade = {
        date: runDate,
        side: 'SELL',
        symbol,
        quantity: existing.quantity,
        price,
        notional: round(notional),
        costs: round(costs.total),
        grossPnl: round(grossPnl),
        netPnl: round(netPnl),
        entryDate: existing.entryDate,
        reasonCodes: evaluation.reasonCodes || [],
        strategyAuthority: 'RULES_ONLY',
      };
      state.trades = [...(state.trades || []), trade];
      events.push(trade);
      state = markToMarket(state, options.priceMap || {});
      continue;
    }

    if (evaluation.action === 'BUY_CANDIDATE' && !existing) {
      if (Object.keys(state.positions).length >= maxPositions) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: 'MAX_ACTIVE_POSITIONS' });
        continue;
      }
      const quantity = calculateShadowQuantity({ state, price, maxPositionWeight, boardLot });
      if (quantity <= 0) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: 'POSITION_SIZE_ZERO' });
        continue;
      }
      const notional = quantity * price;
      const costs = transactionCost(notional, model);
      if (notional + costs.total > Number(state.cash || 0)) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: 'INSUFFICIENT_SHADOW_CASH' });
        continue;
      }
      state.cash = round(Number(state.cash || 0) - notional - costs.total);
      state.positions[symbol] = {
        symbol,
        quantity,
        entryPrice: price,
        entryDate: runDate,
        entryCosts: round(costs.total),
        lastPrice: price,
        marketValue: round(notional),
        strategyVersion: evaluation.ruleVersion,
      };
      const trade = {
        date: runDate,
        side: 'BUY',
        symbol,
        quantity,
        price,
        notional: round(notional),
        costs: round(costs.total),
        reasonCodes: evaluation.reasonCodes || [],
        strategyAuthority: 'RULES_ONLY',
      };
      state.trades = [...(state.trades || []), trade];
      events.push(trade);
      state = markToMarket(state, options.priceMap || {});
    }
  }

  state = markToMarket(state, options.priceMap || {});
  return { state, events };
}

module.exports = {
  applySignals,
  calculateShadowQuantity,
  markToMarket,
};
