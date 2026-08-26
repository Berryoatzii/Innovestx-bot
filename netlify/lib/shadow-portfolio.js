const { loadCostModel } = require('./cost-model');
const { simulateDailyExecution } = require('./execution-realism');

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
  const executionPriceMap = options.executionPriceMap || {};
  const volumeMap = options.volumeMap || {};
  const maxParticipationRate = Number(options.maxParticipationRate ?? 0.01);
  const impactBpsAtMaxParticipation = Number(options.impactBpsAtMaxParticipation ?? 25);
  let state = markToMarket({
    ...stateInput,
    schemaVersion: 2,
    positions: { ...(stateInput.positions || {}) },
    pendingSignals: { ...(stateInput.pendingSignals || {}) },
  }, options.priceMap || {});
  const events = [];

  for (const [symbol, pending] of Object.entries(state.pendingSignals)) {
    if (String(pending.signalDate || '') >= runDate) continue;
    delete state.pendingSignals[symbol];
    const price = Number(executionPriceMap[symbol] || 0);
    const existing = state.positions[symbol];

    if (pending.action === 'BUY_CANDIDATE') {
      if (existing || Object.keys(state.positions).length >= maxPositions) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: existing ? 'POSITION_ALREADY_EXISTS' : 'MAX_ACTIVE_POSITIONS' });
        continue;
      }
      const quantity = calculateShadowQuantity({ state, price, maxPositionWeight, boardLot });
      if (quantity <= 0) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: 'POSITION_SIZE_ZERO' });
        continue;
      }
      const execution = simulateDailyExecution({
        side: 'BUY', requestedQuantity: quantity, referencePrice: price,
        dailyVolume: volumeMap[symbol], boardLot, maxParticipationRate,
        impactBpsAtMaxParticipation, costModel: model,
      });
      if (!execution.filled) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: execution.reason, pendingExpired: true });
        continue;
      }
      if (execution.notional + execution.costs.total > Number(state.cash || 0)) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: 'INSUFFICIENT_SHADOW_CASH' });
        continue;
      }
      state.cash = round(Number(state.cash || 0) - execution.notional - execution.costs.total);
      state.positions[symbol] = {
        symbol,
        quantity,
        entryPrice: execution.price,
        entryDate: runDate,
        signalDate: pending.signalDate,
        entryCosts: round(execution.costs.total),
        lastPrice: execution.price,
        marketValue: round(execution.notional),
        strategyVersion: pending.ruleVersion,
      };
      const trade = {
        date: runDate, signalDate: pending.signalDate, side: 'BUY', symbol, quantity,
        price: execution.price, notional: round(execution.notional),
        costs: round(execution.costs.total), marketImpact: round(execution.costs.marketImpact, 4),
        participationRate: execution.participationRate,
        reasonCodes: pending.reasonCodes || [], strategyAuthority: 'RULES_ONLY',
      };
      state.trades = [...(state.trades || []), trade];
      events.push(trade);
      state = markToMarket(state, options.priceMap || {});
      continue;
    }

    if (pending.action === 'EXIT_REVIEW') {
      if (!existing) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: 'POSITION_NOT_FOUND' });
        continue;
      }
      const execution = simulateDailyExecution({
        side: 'SELL', requestedQuantity: existing.quantity, referencePrice: price,
        dailyVolume: volumeMap[symbol], boardLot, maxParticipationRate,
        impactBpsAtMaxParticipation, costModel: model,
      });
      if (!execution.filled) {
        events.push({ date: runDate, action: 'SKIP', symbol, reason: execution.reason, pendingExpired: true });
        continue;
      }
      const grossPnl = (execution.price - existing.entryPrice) * existing.quantity;
      const netPnl = grossPnl - Number(existing.entryCosts || 0) - execution.costs.total;
      state.cash = round(Number(state.cash || 0) + execution.notional - execution.costs.total);
      delete state.positions[symbol];
      const trade = {
        date: runDate, signalDate: pending.signalDate, side: 'SELL', symbol,
        quantity: existing.quantity, price: execution.price,
        notional: round(execution.notional), costs: round(execution.costs.total),
        marketImpact: round(execution.costs.marketImpact, 4),
        participationRate: execution.participationRate,
        grossPnl: round(grossPnl), netPnl: round(netPnl), entryDate: existing.entryDate,
        reasonCodes: pending.reasonCodes || [], strategyAuthority: 'RULES_ONLY',
      };
      state.trades = [...(state.trades || []), trade];
      events.push(trade);
      state = markToMarket(state, options.priceMap || {});
    }
  }

  for (const evaluation of evaluations) {
    const symbol = String(evaluation.symbol || '').toUpperCase();
    const existing = state.positions[symbol];
    const queueable = (
      (evaluation.action === 'BUY_CANDIDATE' && !existing) ||
      (evaluation.action === 'EXIT_REVIEW' && existing)
    );
    if (!queueable || state.pendingSignals[symbol]) continue;
    state.pendingSignals[symbol] = {
      action: evaluation.action,
      signalDate: runDate,
      reasonCodes: evaluation.reasonCodes || [],
      ruleVersion: evaluation.ruleVersion || null,
    };
    events.push({ date: runDate, action: 'QUEUED_NEXT_SESSION', symbol, signal: evaluation.action });
  }

  state = markToMarket(state, options.priceMap || {});
  return { state, events };
}

module.exports = {
  applySignals,
  calculateShadowQuantity,
  markToMarket,
};
