const candidate = require('../../config/strategy-approval-candidate.json');

const DR_SYMBOLS = new Set(candidate.approvalScope.symbols);

function normalize(value) {
  return String(value || '').trim().toUpperCase();
}

function isCandidateDrIntent(intent = {}) {
  return normalize(intent.instrumentType) === 'DR'
    && DR_SYMBOLS.has(normalize(intent.symbol))
    && String(intent.candidateId || '') === candidate.candidateId
    && String(intent.strategyVersion || '') === candidate.strategyVersion
    && Number(intent.boardLot) === 1
    && normalize(intent.orderStyle) === 'RESTING_LIMIT'
    && normalize(intent.portfolioBucket) === 'ACTIVE';
}

function isCandidateDrFullExit(intent = {}, heldQuantity) {
  const held = Math.floor(Number(heldQuantity || 0));
  const quantity = Math.floor(Number(intent.quantity || 0));
  return isCandidateDrIntent(intent)
    && normalize(intent.side) === 'SELL'
    && normalize(intent.exitMode) === 'FULL_POSITION'
    && held > 0
    && quantity === held
    && Math.floor(Number(intent.portfolioQty || 0)) === held;
}

module.exports = {
  candidate,
  isCandidateDrIntent,
  isCandidateDrFullExit,
};
