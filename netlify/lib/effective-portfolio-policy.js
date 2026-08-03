const { loadPortfolioPolicy, validatePolicy } = require('./portfolio-policy');
const { listClassifications } = require('./portfolio-classification-store');

function removeSymbol(policy, symbol) {
  for (const key of ['coreSymbols', 'activeSymbols', 'reviewSymbols']) {
    policy.classification[key] = (policy.classification[key] || []).filter((item) => item !== symbol);
  }
}

function addSymbol(policy, symbol, bucket) {
  const key = bucket === 'CORE'
    ? 'coreSymbols'
    : bucket === 'ACTIVE'
      ? 'activeSymbols'
      : 'reviewSymbols';
  if (!policy.classification[key].includes(symbol)) policy.classification[key].push(symbol);
}

async function loadEffectivePortfolioPolicy(event, env = process.env) {
  const policy = loadPortfolioPolicy(env);
  const classifications = await listClassifications(event);
  for (const item of classifications) {
    const symbol = String(item.symbol || '').toUpperCase();
    const bucket = String(item.bucket || 'REVIEW').toUpperCase();
    removeSymbol(policy, symbol);
    addSymbol(policy, symbol, bucket);
  }
  validatePolicy(policy);
  return {
    policy,
    classifications,
    source: classifications.length > 0 ? 'BASE_PLUS_OPERATOR_STORE' : 'BASE_POLICY_ONLY',
  };
}

module.exports = {
  loadEffectivePortfolioPolicy,
  _test: { removeSymbol, addSymbol },
};
