const basePolicy = require('../../config/portfolio-policy.json');

const VALID_POSITION_BUCKETS = new Set(['CORE', 'ACTIVE', 'REVIEW']);

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function loadPortfolioPolicy(env = process.env) {
  const policy = JSON.parse(JSON.stringify(basePolicy));
  const envCore = parseCsv(env.CORE_SYMBOLS);
  const envActive = parseCsv(env.ACTIVE_SYMBOLS);
  const envReview = parseCsv(env.REVIEW_SYMBOLS);

  policy.classification.coreSymbols = unique([
    ...policy.classification.coreSymbols,
    ...envCore,
  ]);
  policy.classification.activeSymbols = unique([
    ...policy.classification.activeSymbols,
    ...envActive,
  ]);
  policy.classification.reviewSymbols = unique([
    ...policy.classification.reviewSymbols,
    ...envReview,
  ]);

  const targetCore = Number(env.CORE_TARGET_WEIGHT);
  const targetActive = Number(env.ACTIVE_TARGET_WEIGHT);
  const targetCash = Number(env.CASH_TARGET_WEIGHT);
  if (Number.isFinite(targetCore) && targetCore >= 0 && targetCore <= 1) policy.targets.CORE = targetCore;
  if (Number.isFinite(targetActive) && targetActive >= 0 && targetActive <= 1) policy.targets.ACTIVE = targetActive;
  if (Number.isFinite(targetCash) && targetCash >= 0 && targetCash <= 1) policy.targets.CASH = targetCash;
  policy.targets.REVIEW = Math.max(0, 1 - policy.targets.CORE - policy.targets.ACTIVE - policy.targets.CASH);

  validatePolicy(policy);
  return policy;
}

function validatePolicy(policy) {
  const all = {
    CORE: policy.classification.coreSymbols || [],
    ACTIVE: policy.classification.activeSymbols || [],
    REVIEW: policy.classification.reviewSymbols || [],
  };
  const seen = new Map();
  for (const [bucket, symbols] of Object.entries(all)) {
    for (const symbol of symbols) {
      if (seen.has(symbol)) throw new Error(`POLICY_SYMBOL_OVERLAP:${symbol}:${seen.get(symbol)}:${bucket}`);
      seen.set(symbol, bucket);
    }
  }

  const totalTarget =
    Number(policy.targets.CORE || 0) +
    Number(policy.targets.ACTIVE || 0) +
    Number(policy.targets.CASH || 0) +
    Number(policy.targets.REVIEW || 0);
  if (Math.abs(totalTarget - 1) > 0.000001) throw new Error(`POLICY_TARGETS_MUST_SUM_TO_ONE:${totalTarget}`);
  if (!VALID_POSITION_BUCKETS.has(policy.classification.defaultBucket)) throw new Error('POLICY_INVALID_DEFAULT_BUCKET');
  return true;
}

function classifySymbol(symbol, policy = loadPortfolioPolicy()) {
  const normalized = String(symbol || '').toUpperCase().trim();
  if (!normalized) throw new Error('INVALID_SYMBOL');
  if (policy.classification.coreSymbols.includes(normalized)) return 'CORE';
  if (policy.classification.activeSymbols.includes(normalized)) return 'ACTIVE';
  if (policy.classification.reviewSymbols.includes(normalized)) return 'REVIEW';
  return policy.classification.defaultBucket || 'REVIEW';
}

function segmentPortfolio(portfolio, policy = loadPortfolioPolicy()) {
  return (Array.isArray(portfolio) ? portfolio : []).map((position) => {
    const symbol = String(position.sym || position.symbol || '').toUpperCase();
    const qty = Number(position.qty || position.quantity || 0);
    const price = Number(position.mkt || position.marketPrice || position.last || 0);
    const marketValue = qty > 0 && price > 0 ? qty * price : 0;
    return {
      ...position,
      sym: symbol,
      bucket: classifySymbol(symbol, policy),
      marketValue,
    };
  });
}

function summarizeAllocation(segmented, cash = 0, policy = loadPortfolioPolicy()) {
  const totals = { CORE: 0, ACTIVE: 0, REVIEW: 0, CASH: Math.max(0, Number(cash || 0)) };
  for (const item of segmented) {
    if (VALID_POSITION_BUCKETS.has(item.bucket)) totals[item.bucket] += Number(item.marketValue || 0);
  }
  const portfolioValue = totals.CORE + totals.ACTIVE + totals.REVIEW + totals.CASH;
  const weights = {};
  for (const key of Object.keys(totals)) weights[key] = portfolioValue > 0 ? totals[key] / portfolioValue : 0;

  const unclassified = segmented.filter((item) => item.bucket === 'REVIEW').map((item) => item.sym);
  const violations = [];
  if (unclassified.length > 0) violations.push({ code: 'UNCLASSIFIED_REVIEW_POSITIONS', symbols: unclassified });
  if (weights.CORE > policy.targets.CORE + 0.10) violations.push({ code: 'CORE_OVER_TARGET', actual: weights.CORE, target: policy.targets.CORE });
  if (weights.ACTIVE > policy.targets.ACTIVE + 0.05) violations.push({ code: 'ACTIVE_OVER_TARGET', actual: weights.ACTIVE, target: policy.targets.ACTIVE });
  if (weights.CASH + 0.000001 < policy.targets.CASH) violations.push({ code: 'CASH_BELOW_TARGET', actual: weights.CASH, target: policy.targets.CASH });

  return { totals, weights, portfolioValue, violations };
}

function orderEligibility({ symbol, action, evidence = {}, policy = loadPortfolioPolicy() }) {
  const bucket = classifySymbol(symbol, policy);
  const normalizedAction = String(action || '').toUpperCase();

  if (bucket === 'REVIEW') return { eligible: false, bucket, reason: 'REVIEW_BUCKET_NO_ORDERS' };

  if (bucket === 'CORE') {
    if (normalizedAction.includes('SELL')) {
      return { eligible: false, bucket, reason: 'CORE_SELL_REQUIRES_MANUAL_THESIS_BREAK' };
    }
    const required = [
      ['fundamentalPassed', 'CORE_FUNDAMENTAL_GATE_FAILED'],
      ['thesisApproved', 'CORE_THESIS_NOT_APPROVED'],
      ['valuationPassed', 'CORE_VALUATION_GATE_FAILED'],
      ['corporateActionClear', 'CORE_CORPORATE_ACTION_UNCLEAR'],
      ['cashReserveMaintained', 'CORE_CASH_RESERVE_BREACH'],
    ];
    const failed = required.find(([key]) => evidence[key] !== true);
    if (failed) return { eligible: false, bucket, reason: failed[1] };
    if (!['CORE_BUY_CANDIDATE', 'CORE_ADD_CANDIDATE'].includes(normalizedAction)) {
      return { eligible: false, bucket, reason: 'CORE_ACTION_NOT_SUPPORTED' };
    }
    return { eligible: true, bucket, reason: 'CORE_EVIDENCE_APPROVED' };
  }

  if (bucket === 'ACTIVE') {
    if (evidence.rulesPassed !== true) return { eligible: false, bucket, reason: 'ACTIVE_RULES_GATE_FAILED' };
    if (evidence.corporateActionClear !== true) return { eligible: false, bucket, reason: 'ACTIVE_CORPORATE_ACTION_UNCLEAR' };
    if (evidence.cashReserveMaintained !== true) return { eligible: false, bucket, reason: 'ACTIVE_CASH_RESERVE_BREACH' };
    return { eligible: true, bucket, reason: 'ACTIVE_RULES_ELIGIBLE' };
  }

  return { eligible: false, bucket, reason: 'UNKNOWN_BUCKET' };
}

module.exports = {
  loadPortfolioPolicy,
  validatePolicy,
  classifySymbol,
  segmentPortfolio,
  summarizeAllocation,
  orderEligibility,
  _test: { parseCsv },
};
