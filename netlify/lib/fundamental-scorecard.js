const policyFile = require('../../config/core-fundamental-policy.json');

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  const rows = values.map(finite).filter((value) => value != null).sort((a, b) => a - b);
  if (rows.length === 0) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function cagr(start, end, years) {
  const a = finite(start);
  const b = finite(end);
  const n = Number(years);
  if (a == null || b == null || a <= 0 || b <= 0 || !Number.isFinite(n) || n <= 0) return null;
  return Math.pow(b / a, 1 / n) - 1;
}

function countPositive(rows, key) {
  return rows.filter((row) => finite(row?.[key]) > 0).length;
}

function mergeProfile(sectorProfile, policy = policyFile) {
  const specific = policy.sectorProfiles?.[sectorProfile] || {};
  return {
    ...policy.general,
    ...specific,
    disableMetrics: new Set(specific.disableMetrics || []),
    requiredManualEvidence: specific.requiredManualEvidence || [],
  };
}

function check(gates, code, passed, actual = null, threshold = null, severity = 'HARD') {
  gates.push({ code, passed: Boolean(passed), actual, threshold, severity });
}

function normalizeAnnuals(snapshot) {
  return (Array.isArray(snapshot?.annuals) ? snapshot.annuals : [])
    .filter((row) => row && Number(row.year))
    .sort((a, b) => Number(a.year) - Number(b.year))
    .slice(-5);
}

function latestAnnual(snapshot) {
  const rows = normalizeAnnuals(snapshot);
  return rows[rows.length - 1] || null;
}

function evaluateFundamentals(snapshot, options = {}) {
  const policy = options.policy || policyFile;
  const profileName = snapshot?.sectorProfile || 'GENERAL';
  const profile = mergeProfile(profileName, policy);
  const annuals = normalizeAnnuals(snapshot);
  const latest = latestAnnual(snapshot) || {};
  const market = snapshot?.market || {};
  const gates = [];
  const warnings = [];

  if (!snapshot?.symbol) check(gates, 'SYMBOL_PRESENT', false);
  if (annuals.length < 3) check(gates, 'MINIMUM_3_ANNUAL_PERIODS', false, annuals.length, 3);

  const roeMedian = median(annuals.slice(-3).map((row) => row.roePct));
  const roaMedian = median(annuals.slice(-3).map((row) => row.roaPct));
  const deLatest = finite(latest.debtToEquity);
  const interestCoverage = finite(latest.interestCoverage);
  const payoutMedian = median(annuals.map((row) => row.payoutRatioPct));
  const dividendYears = annuals.filter((row) => finite(row.dividendPerShare) > 0).length;
  const positiveEarningsYears = countPositive(annuals, 'netIncome');
  const positiveOcfYears = countPositive(annuals, 'operatingCashFlow');
  const positiveFcfYears = countPositive(annuals, 'freeCashFlow');
  const epsRows = annuals.map((row) => finite(row.eps)).filter((value) => value != null && value > 0);
  const epsCagr = epsRows.length >= 4 ? cagr(epsRows[epsRows.length - 4], epsRows[epsRows.length - 1], 3) : null;
  const pe = finite(market.pe);
  const ownMedianPe = finite(market.ownMedianPe);
  const sectorMedianPe = finite(market.sectorMedianPe);
  const dividendYield = finite(market.dividendYieldPct);
  const retainedEarnings = finite(latest.retainedEarnings);
  const auditOpinion = String(snapshot?.auditOpinion || '').toUpperCase();
  const manualEvidence = snapshot?.manualEvidence || {};

  if (!profile.disableMetrics.has('ROE')) {
    check(gates, 'ROE_3Y_MEDIAN', roeMedian != null && roeMedian >= profile.minimumMedianRoePct3Y, roeMedian, profile.minimumMedianRoePct3Y);
  }
  if (!profile.disableMetrics.has('ROA')) {
    check(gates, 'ROA_3Y_MEDIAN', roaMedian != null && roaMedian >= profile.minimumMedianRoaPct3Y, roaMedian, profile.minimumMedianRoaPct3Y);
  }
  if (!profile.disableMetrics.has('D_E')) {
    check(gates, 'DEBT_TO_EQUITY', deLatest != null && deLatest <= profile.maximumDebtToEquity, deLatest, profile.maximumDebtToEquity);
  }
  if (!profile.disableMetrics.has('INTEREST_COVERAGE')) {
    check(gates, 'INTEREST_COVERAGE', interestCoverage != null && interestCoverage >= profile.minimumInterestCoverage, interestCoverage, profile.minimumInterestCoverage);
  }
  if (!profile.disableMetrics.has('PE')) {
    const peAbsolute = pe != null && pe > 0 && pe <= profile.maximumPe;
    const peOwnRelative = ownMedianPe != null && pe != null ? pe <= ownMedianPe * profile.maximumPeVsOwnMedian : null;
    const peSectorRelative = sectorMedianPe != null && pe != null ? pe <= sectorMedianPe * profile.maximumPeVsSectorMedian : null;
    const relativeEvidence = [peOwnRelative, peSectorRelative].filter((value) => value != null);
    check(gates, 'VALUATION_PE', peAbsolute && (relativeEvidence.length === 0 || relativeEvidence.some(Boolean)), {
      pe, ownMedianPe, sectorMedianPe,
    }, {
      maximumPe: profile.maximumPe,
      maximumPeVsOwnMedian: profile.maximumPeVsOwnMedian,
      maximumPeVsSectorMedian: profile.maximumPeVsSectorMedian,
    });
  }

  check(gates, 'DIVIDEND_YIELD_MINIMUM', dividendYield != null && dividendYield >= profile.minimumDividendYieldPct, dividendYield, profile.minimumDividendYieldPct);
  if (dividendYield != null && dividendYield < profile.preferredDividendYieldPct) warnings.push('DIVIDEND_BELOW_PREFERRED_5PCT');
  check(gates, 'DIVIDEND_HISTORY', dividendYears >= profile.minimumDividendYearsPaidOfFive, dividendYears, profile.minimumDividendYearsPaidOfFive);
  check(gates, 'PAYOUT_RATIO_SUSTAINABLE', payoutMedian != null && payoutMedian > 0 && payoutMedian <= profile.maximumMedianPayoutRatioPct, payoutMedian, profile.maximumMedianPayoutRatioPct);
  check(gates, 'POSITIVE_EARNINGS_HISTORY', positiveEarningsYears >= profile.minimumPositiveEarningsYearsOfFive, positiveEarningsYears, profile.minimumPositiveEarningsYearsOfFive);
  check(gates, 'OPERATING_CASH_FLOW_HISTORY', positiveOcfYears >= profile.minimumPositiveOperatingCashFlowYearsOfFive, positiveOcfYears, profile.minimumPositiveOperatingCashFlowYearsOfFive);
  check(gates, 'FREE_CASH_FLOW_HISTORY', positiveFcfYears >= profile.minimumPositiveFreeCashFlowYearsOfFive, positiveFcfYears, profile.minimumPositiveFreeCashFlowYearsOfFive);
  if (!profile.disableMetrics.has('EPS_CAGR')) {
    check(gates, 'EPS_CAGR_3Y', epsCagr != null && epsCagr >= profile.minimumEpsCagr3Y, epsCagr, profile.minimumEpsCagr3Y);
  }
  if (profile.requirePositiveRetainedEarnings) {
    check(gates, 'POSITIVE_RETAINED_EARNINGS', retainedEarnings != null && retainedEarnings > 0, retainedEarnings, '>0');
  }
  if (profile.requireUnqualifiedAuditOpinion) {
    const unqualified = auditOpinion.includes('UNQUALIFIED') || auditOpinion.includes('ไม่มีเงื่อนไข');
    check(gates, 'AUDIT_OPINION_UNQUALIFIED', unqualified, auditOpinion || null, 'UNQUALIFIED');
  }

  for (const evidenceKey of profile.requiredManualEvidence) {
    check(gates, `MANUAL_${evidenceKey}`, manualEvidence[evidenceKey] === true, manualEvidence[evidenceKey] ?? null, true);
  }

  const hardFailures = gates.filter((gate) => gate.severity === 'HARD' && !gate.passed);
  const passed = hardFailures.length === 0;
  const status = passed ? 'PASS' : (hardFailures.length <= 2 ? 'REVIEW' : 'FAIL');

  return {
    schemaVersion: 1,
    strategyVersion: policy.strategyVersion,
    symbol: String(snapshot?.symbol || '').toUpperCase(),
    sectorProfile: profileName,
    asOf: snapshot?.asOf || null,
    status,
    passed,
    gates,
    hardFailures: hardFailures.map((item) => item.code),
    warnings,
    metrics: {
      roeMedian3Y: roeMedian,
      roaMedian3Y: roaMedian,
      debtToEquity: deLatest,
      interestCoverage,
      payoutMedian5Y: payoutMedian,
      dividendYearsPaidOfFive: dividendYears,
      positiveEarningsYearsOfFive: positiveEarningsYears,
      positiveOcfYearsOfFive: positiveOcfYears,
      positiveFcfYearsOfFive: positiveFcfYears,
      epsCagr3Y: epsCagr,
      pe,
      ownMedianPe,
      sectorMedianPe,
      dividendYieldPct: dividendYield,
      retainedEarnings,
    },
  };
}

function detectThesisBreak(snapshot, previousSnapshot, options = {}) {
  const policy = options.policy || policyFile;
  const triggers = policy.thesisBreakTriggers;
  const reasons = [];
  const latest = snapshot?.latestQuarter || {};
  const previous = previousSnapshot?.latestQuarter || {};

  const epsYoy = finite(latest.epsGrowthYoYPct);
  if (epsYoy != null && epsYoy <= triggers.epsDeclineYoYPct) reasons.push('EPS_DECLINE_TRIGGER');
  const weakQuarters = Number(snapshot?.consecutiveWeakQuarters || 0);
  if (weakQuarters >= triggers.consecutiveWeakQuarters) reasons.push('CONSECUTIVE_WEAK_QUARTERS');
  const dividendChange = finite(snapshot?.dividendChangePct);
  if (dividendChange != null && dividendChange <= triggers.dividendCutPct) reasons.push('DIVIDEND_CUT_TRIGGER');
  const latestRoe = finite(latest.roePct);
  const priorRoe = finite(previous.roePct);
  if (latestRoe != null && priorRoe != null && latestRoe - priorRoe <= triggers.roeDropPctPoints) reasons.push('ROE_DETERIORATION_TRIGGER');
  const latestDe = finite(latest.debtToEquity);
  const priorDe = finite(previous.debtToEquity);
  if (latestDe != null && priorDe != null && priorDe > 0 && latestDe / priorDe >= triggers.deIncreaseMultiple) reasons.push('LEVERAGE_SPIKE_TRIGGER');
  if (snapshot?.auditorOpinionChanged === true && triggers.auditorOpinionChanged) reasons.push('AUDITOR_OPINION_CHANGED');
  if (snapshot?.moatLost === true && triggers.moatLost) reasons.push('MOAT_LOST');
  if (snapshot?.materialDisruption === true && triggers.materialDisruption) reasons.push('MATERIAL_DISRUPTION');
  if (snapshot?.governanceRedFlag === true && triggers.governanceRedFlag) reasons.push('GOVERNANCE_RED_FLAG');

  return { broken: reasons.length > 0, reasons };
}

function evaluateAveragingDown({
  currentSnapshot,
  previousSnapshot,
  thesisApproval,
  currentPrice,
  lastTranchePrice,
  currentPositionWeight,
  maxPositionWeight,
  valuationPassed,
  freshFundamentals,
  policy = policyFile,
}) {
  const fundamental = evaluateFundamentals(currentSnapshot, { policy });
  const thesisBreak = detectThesisBreak(currentSnapshot, previousSnapshot, { policy });
  const declinePct = Number(lastTranchePrice) > 0
    ? (Number(currentPrice) / Number(lastTranchePrice) - 1) * 100
    : null;
  const rules = policy.averagingRules;
  const reasons = [];

  if (!fundamental.passed) reasons.push('FUNDAMENTALS_NOT_PASSED');
  if (thesisBreak.broken) reasons.push(...thesisBreak.reasons);
  if (thesisApproval?.approved !== true) reasons.push(thesisApproval?.reason || 'THESIS_NOT_APPROVED');
  if (freshFundamentals !== true) reasons.push('FUNDAMENTALS_NOT_FRESH');
  if (valuationPassed !== true) reasons.push('VALUATION_NOT_PASSED');
  if (declinePct == null || declinePct > -rules.minimumPriceDeclineFromLastTranchePct) reasons.push('PRICE_NOT_AT_NEXT_TRANCHE');
  if (declinePct != null && declinePct < -rules.maximumPriceDeclineTriggerPct) reasons.push('PRICE_DECLINE_REQUIRES_FULL_THESIS_REVIEW');
  if (Number(currentPositionWeight) >= Number(maxPositionWeight)) reasons.push('POSITION_WEIGHT_LIMIT');
  if (currentSnapshot?.dividendChangePct <= policy.thesisBreakTriggers.dividendCutPct) reasons.push('DIVIDEND_CUT_BLOCK');

  return {
    allowed: reasons.length === 0,
    action: reasons.length === 0 ? 'CORE_ADD_CANDIDATE' : 'NO_TRADE',
    declinePct,
    reasons,
    fundamental,
    thesisBreak,
  };
}

module.exports = {
  evaluateFundamentals,
  detectThesisBreak,
  evaluateAveragingDown,
  _test: { finite, median, cagr, mergeProfile, normalizeAnnuals },
};
