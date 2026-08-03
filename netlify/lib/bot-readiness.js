const corePolicy = require('../../config/core-fundamental-policy.json');
const { fetchBrokerPortfolio } = require('./broker-portfolio');
const { classificationMap, summarizeClassifications } = require('./portfolio-classification-store');
const { loadEffectivePortfolioPolicy } = require('./effective-portfolio-policy');
const { listBacktestResults } = require('./research-results-store');
const { listDailyReports, evaluateShadowGate } = require('./shadow-performance-store');
const { getSnapshot, snapshotFreshness } = require('./fundamental-snapshot-store');
const { getThesisCard, isThesisApproved } = require('./core-thesis-store');
const { evaluateFundamentals } = require('./fundamental-scorecard');
const { approvalAvailability } = require('./approval-executor');

async function inspectCoreEvidence(symbols, event) {
  const rows = [];
  for (const symbol of symbols) {
    const snapshot = await getSnapshot(symbol, event);
    const thesis = await getThesisCard(symbol, event);
    const freshness = snapshotFreshness(snapshot, corePolicy);
    const thesisState = isThesisApproved(thesis);
    const fundamentals = snapshot ? evaluateFundamentals(snapshot, { policy: corePolicy }) : null;
    const passed = Boolean(snapshot && thesis && freshness.fresh && thesisState.approved && fundamentals?.passed);
    rows.push({
      symbol,
      passed,
      snapshot: Boolean(snapshot),
      fresh: freshness.fresh,
      thesisApproved: thesisState.approved,
      fundamentalsPassed: Boolean(fundamentals?.passed),
      blockers: [
        !snapshot ? 'MISSING_FUNDAMENTAL_SNAPSHOT' : null,
        !freshness.fresh ? freshness.reason : null,
        !thesisState.approved ? thesisState.reason : null,
        fundamentals && !fundamentals.passed ? ...[] : null,
      ].filter(Boolean),
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
  const classification = summarizeClassifications(broker.portfolio, map);
  if (!classification.complete) blockers.push(`CLASSIFY_${classification.counts.UNCLASSIFIED}_POSITIONS`);

  const { policy } = await loadEffectivePortfolioPolicy(event);
  const activeSymbols = policy.classification.activeSymbols || [];
  const coreSymbols = policy.classification.coreSymbols || [];

  const backtests = await listBacktestResults(event);
  const backtestMap = Object.fromEntries(backtests.map((item) => [item.symbol, item]));
  const activeResearch = activeSymbols.map((symbol) => ({
    symbol,
    exists: Boolean(backtestMap[symbol]),
    passed: Boolean(backtestMap[symbol]?.gate?.passed),
    recordedAt: backtestMap[symbol]?.recordedAt || null,
  }));
  const activePassed = activeResearch.filter((item) => item.passed).length;
  if (activeSymbols.length === 0) blockers.push('NO_ACTIVE_SYMBOLS');
  if (activeSymbols.length > 0 && activePassed === 0) blockers.push('NO_ACTIVE_BACKTEST_PASSED');

  const reports = await listDailyReports(event, 400);
  const shadowGate = evaluateShadowGate(reports, {
    minimumDays: policy.research.minimumShadowTradingDays,
    minimumEvents: policy.research.minimumDecisionEvents,
  });
  if (!shadowGate.passed) {
    blockers.push(`SHADOW_${shadowGate.tradingDays}D_${shadowGate.decisionEvents}EVENTS`);
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
  const observeReady = brokerConnected && telegramReady;
  const researchReady = observeReady && classification.complete && (activeSymbols.length + coreSymbols.length > 0);
  const proposalReady = researchReady && activePassed > 0 && shadowGate.passed;
  const livePilotReady = proposalReady && approval.ready;

  return {
    generatedAt: new Date().toISOString(),
    stages: {
      observeReady,
      researchReady,
      proposalReady,
      livePilotReady,
    },
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
      total: activeSymbols.length,
      rows: activeResearch,
    },
    shadowGate,
    approval,
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
    `Live locks: ${readiness.approval.ready ? '✅ พร้อม' : '🔒 ปิด'}`,
  ];
  if (readiness.blockers.length > 0) {
    rows.push('', 'สิ่งที่ยังติด:', ...readiness.blockers.slice(0, 10).map((item) => `• ${item}`));
  }
  return rows.join('\n');
}

module.exports = { buildBotReadiness, readinessText };
