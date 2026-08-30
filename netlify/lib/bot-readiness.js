const corePolicy = require('../../config/core-fundamental-policy.json');
const { fetchBrokerPortfolio } = require('./broker-portfolio');
const { loadPortfolioPolicy } = require('./portfolio-policy');
const { classificationMap, summarizeClassifications } = require('./portfolio-classification-store');
const { loadEffectivePortfolioPolicy } = require('./effective-portfolio-policy');
const { listBacktestResults } = require('./research-results-store');
const { listDailyReports, evaluateShadowGate } = require('./shadow-performance-store');
const { getForwardShadowLedger } = require('./dr-forward-shadow-store');
const { getSnapshot, snapshotFreshness } = require('./fundamental-snapshot-store');
const { getThesisCard, isThesisApproved } = require('./core-thesis-store');
const { evaluateFundamentals } = require('./fundamental-scorecard');
const { approvalAvailability } = require('./approval-executor');
const { loadReleaseConfig } = require('./release-config');
const releaseConfig = loadReleaseConfig();
const { evaluateReleaseEvidence, deriveReadinessStages } = require('./real-money-release');

async function inspectCoreEvidence(symbols, event) {
  const rows = [];
  for (const symbol of symbols) {
    const snapshot = await getSnapshot(symbol, event);
    const thesis = await getThesisCard(symbol, event);
    const freshness = snapshotFreshness(snapshot, corePolicy);
    const thesisState = isThesisApproved(thesis);
    const fundamentals = snapshot ? evaluateFundamentals(snapshot, { policy: corePolicy }) : null;
    const passed = Boolean(snapshot && thesis && freshness.fresh && thesisState.approved && fundamentals?.passed);
    const blockers = [
      !snapshot ? 'MISSING_FUNDAMENTAL_SNAPSHOT' : null,
      !freshness.fresh ? freshness.reason : null,
      !thesisState.approved ? thesisState.reason : null,
      ...(fundamentals && !fundamentals.passed
        ? (fundamentals.hardFailures || fundamentals.reasons || ['FUNDAMENTALS_NOT_PASSED'])
        : []),
    ].filter(Boolean);
    rows.push({
      symbol,
      passed,
      snapshot: Boolean(snapshot),
      fresh: freshness.fresh,
      thesisApproved: thesisState.approved,
      fundamentalsPassed: Boolean(fundamentals?.passed),
      blockers: [...new Set(blockers)],
    });
  }
  return rows;
}

async function buildBotReadiness(event = {}) {
  const blockers = [];
  let broker = { portfolio: [], cash: 0 };
  let brokerConnected = false;
  let brokerError = null;
  try {
    broker = await fetchBrokerPortfolio(event);
    brokerConnected = true;
  } catch (error) {
    brokerError = error.message;
    blockers.push(`BROKER:${error.message}`);
  }

  const map = await classificationMap(event);
  const classification = summarizeClassifications(broker.portfolio, map, loadPortfolioPolicy());
  if (!classification.complete) blockers.push(`CLASSIFY_${classification.counts.UNCLASSIFIED}_POSITIONS`);

  const { policy } = await loadEffectivePortfolioPolicy(event);
  const activeSymbols = policy.classification.activeSymbols || [];
  const coreSymbols = policy.classification.coreSymbols || [];
  const researchSymbols = policy.research?.shadowSymbols || activeSymbols;

  const backtests = await listBacktestResults(event);
  const backtestMap = Object.fromEntries(backtests.map((item) => [item.symbol, item]));
  const activeResearch = researchSymbols.map((symbol) => ({
    symbol,
    exists: Boolean(backtestMap[symbol]),
    passed: Boolean(backtestMap[symbol]?.gate?.passed),
    recordedAt: backtestMap[symbol]?.recordedAt || null,
  }));
  const activePassed = activeResearch.filter((item) => item.passed).length;
  if (researchSymbols.length === 0) blockers.push('NO_SHADOW_RESEARCH_SYMBOLS');
  if (researchSymbols.length > 0 && activePassed === 0) blockers.push('NO_ACTIVE_BACKTEST_PASSED');

  const reports = await listDailyReports(event, 400);
  const shadowGate = evaluateShadowGate(reports, {
    minimumDays: policy.research.minimumShadowTradingDays,
    minimumEvents: policy.research.minimumDecisionEvents,
    minimumTradeEvents: policy.research.minimumShadowTradeEvents,
    maximumDrawdown: policy.research.maximumShadowDrawdown,
    minimumAfterCostReturn: policy.research.minimumAfterCostReturn,
    minimumExcessReturn: policy.research.minimumBenchmarkExcessReturn,
  });
  if (!shadowGate.passed) {
    blockers.push(`SHADOW_${shadowGate.tradingDays}D_${shadowGate.decisionEvents}EVENTS`);
  }

  let drForwardShadow = {
    passed: false,
    tradingDays: 0,
    instrumentDecisionEvents: 0,
    rebalanceEvents: 0,
    dataErrors: 0,
    error: null,
  };
  try {
    const { ledger } = await getForwardShadowLedger(event, 'eventual');
    drForwardShadow = {
      passed: Boolean(ledger.passed),
      tradingDays: Number(ledger.tradingDays || 0),
      instrumentDecisionEvents: Number(ledger.instrumentDecisionEvents || 0),
      rebalanceEvents: Number(ledger.rebalanceEvents || 0),
      dataErrors: Number(ledger.dataErrors || 0),
      error: null,
    };
  } catch (error) {
    drForwardShadow.error = error.message;
  }
  if (!drForwardShadow.passed) {
    blockers.push(`DR_FORWARD_SHADOW_${drForwardShadow.tradingDays}D_${drForwardShadow.rebalanceEvents}REBALANCES`);
  }

  const coreEvidence = await inspectCoreEvidence(coreSymbols, event);
  const corePassed = coreEvidence.filter((item) => item.passed).length;
  if (coreSymbols.length > 0 && corePassed < coreSymbols.length) {
    blockers.push(`CORE_EVIDENCE_${corePassed}_OF_${coreSymbols.length}`);
  }

  const telegramReady = Boolean(
    process.env.TELEGRAM_TOKEN &&
    process.env.TELEGRAM_CHAT_ID &&
    process.env.TELEGRAM_APPROVER_USER_ID &&
    process.env.TELEGRAM_WEBHOOK_SECRET
  );
  if (!telegramReady) blockers.push('TELEGRAM_APPROVER_NOT_FULLY_CONFIGURED');

  const approval = approvalAvailability();
  const releaseEvidence = evaluateReleaseEvidence(releaseConfig);
  blockers.push(...releaseEvidence.blockers);
  const stages = deriveReadinessStages({
    brokerConnected,
    telegramReady,
    classificationComplete: classification.complete,
    hasResearchSymbols: researchSymbols.length + coreSymbols.length > 0,
    activePassed,
    shadowPassed: shadowGate.passed && drForwardShadow.passed,
    approvalReady: approval.ready,
    releasePassed: releaseEvidence.passed,
    blockers,
  });

  return {
    generatedAt: new Date().toISOString(),
    stages,
    broker: {
      connected: brokerConnected,
      error: brokerError,
      positions: broker.portfolio.length,
      cash: broker.cash,
    },
    telegramReady,
    classification,
    policy: {
      coreSymbols,
      activeSymbols,
      researchSymbols,
      reviewSymbols: policy.classification.reviewSymbols || [],
      targets: policy.targets,
    },
    coreEvidence: {
      passed: corePassed,
      total: coreSymbols.length,
      rows: coreEvidence,
    },
    activeResearch: {
      passed: activePassed,
      total: researchSymbols.length,
      rows: activeResearch,
    },
    shadowGate,
    drForwardShadow,
    approval,
    releaseEvidence,
    blockers: [...new Set(blockers)],
  };
}

function readinessText(readiness) {
  const stage = readiness.stages.livePilotReady
    ? '🟢 พร้อม Limited Live Pilot'
    : readiness.stages.proposalReady
      ? '🟡 พร้อมสร้างข้อเสนอ แต่ Live ยังล็อก'
      : readiness.stages.researchReady
        ? '🟡 กำลังสะสมหลักฐาน Research/Shadow'
        : readiness.stages.observeReady
          ? '🟠 เชื่อมต่อแล้ว แต่ Setup ยังไม่ครบ'
          : '🔴 ระบบยังไม่พร้อมใช้งาน';

  const rows = [
    '🧭 BOT READINESS',
    stage,
    '',
    `Broker: ${readiness.broker.connected ? '✅' : '❌'} | พอร์ต ${readiness.broker.positions} ตัว`,
    `Telegram: ${readiness.telegramReady ? '✅' : '❌'}`,
    `จัดหมวด: ${readiness.classification.complete ? '✅ ครบ' : `⏳ เหลือ ${readiness.classification.counts.UNCLASSIFIED}`}`,
    `CORE evidence: ${readiness.coreEvidence.passed}/${readiness.coreEvidence.total}`,
    `ACTIVE backtest: ${readiness.activeResearch.passed}/${readiness.activeResearch.total}`,
    `Shadow: ${readiness.shadowGate.tradingDays} วัน / ${readiness.shadowGate.decisionEvents} decisions`,
    `RC2 DR shadow: ${readiness.drForwardShadow.tradingDays} วัน / ${readiness.drForwardShadow.rebalanceEvents} rebalance`,
    `Live locks: ${readiness.approval.ready ? '✅ พร้อม' : '🔒 ปิด'}`,
  ];
  if (readiness.blockers.length > 0) {
    rows.push('', 'สิ่งที่ยังติด:', ...readiness.blockers.slice(0, 10).map((item) => `• ${item}`));
  }
  return rows.join('\n');
}

module.exports = { buildBotReadiness, readinessText, inspectCoreEvidence };
