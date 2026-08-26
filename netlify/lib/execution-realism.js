const { loadCostModel, transactionCost } = require('./cost-model');

function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function simulateDailyExecution(input = {}) {
  const side = String(input.side || '').toUpperCase();
  const requestedQuantity = Math.floor(Number(input.requestedQuantity || 0));
  const referencePrice = finitePositive(input.referencePrice);
  const dailyVolume = finitePositive(input.dailyVolume);
  const boardLot = Math.max(1, Math.floor(Number(input.boardLot || 100)));
  const maxParticipationRate = Number(input.maxParticipationRate ?? 0.01);
  const impactBpsAtMaxParticipation = Math.max(0, Number(input.impactBpsAtMaxParticipation ?? 25));

  if (!['BUY', 'SELL'].includes(side)) return { filled: false, reason: 'INVALID_SIDE' };
  if (!(requestedQuantity > 0) || requestedQuantity % boardLot !== 0) {
    return { filled: false, reason: 'INVALID_BOARD_LOT_QUANTITY' };
  }
  if (!referencePrice) return { filled: false, reason: 'REFERENCE_PRICE_INVALID' };
  if (!dailyVolume) return { filled: false, reason: 'VOLUME_UNAVAILABLE' };
  if (!(maxParticipationRate > 0 && maxParticipationRate <= 1)) {
    return { filled: false, reason: 'PARTICIPATION_LIMIT_INVALID' };
  }

  const maximumQuantity = Math.floor((dailyVolume * maxParticipationRate) / boardLot) * boardLot;
  if (maximumQuantity < requestedQuantity) {
    return {
      filled: false,
      reason: 'LIQUIDITY_LIMIT',
      requestedQuantity,
      maximumQuantity,
      dailyVolume,
      maxParticipationRate,
    };
  }

  const participationRate = requestedQuantity / dailyVolume;
  const participationFraction = Math.min(1, participationRate / maxParticipationRate);
  const marketImpactBps = impactBpsAtMaxParticipation * Math.pow(participationFraction, 2);
  const notional = requestedQuantity * referencePrice;
  const baseCosts = transactionCost(notional, input.costModel || loadCostModel());
  const marketImpact = notional * marketImpactBps / 10000;

  return {
    filled: true,
    reason: 'FULL_FILL_SIMULATED',
    side,
    quantity: requestedQuantity,
    price: referencePrice,
    notional,
    dailyVolume,
    maximumQuantity,
    participationRate,
    marketImpactBps,
    costs: {
      ...baseCosts,
      marketImpact,
      total: baseCosts.total + marketImpact,
    },
  };
}

module.exports = {
  simulateDailyExecution,
};
