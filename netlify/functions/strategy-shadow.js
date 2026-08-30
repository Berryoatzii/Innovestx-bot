const https = require('https');
const { fetchBrokerPortfolio } = require('../lib/broker-portfolio');
const { loadEffectivePortfolioPolicy } = require('../lib/effective-portfolio-policy');
const { segmentPortfolio, summarizeAllocation } = require('../lib/portfolio-policy');
const { fetchDailyHistory, fetchSetTriSnapshot } = require('../lib/research-market-data');
const { evaluateActiveStrategy, evaluateBenchmarkRegime } = require('../lib/deterministic-strategy');
const { corporateActionGate } = require('../lib/corporate-action-gate');
const { isResearchWindow } = require('../lib/market-calendar');
const { loadCostModel } = require('../lib/cost-model');
const { applySignals, markToMarket } = require('../lib/shadow-portfolio');
const {
  getShadowState,
  saveShadowState,
  saveDailyReport,
  listDailyReports,
  evaluateShadowGate,
} = require('../lib/shadow-performance-store');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

function postTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return Promise.resolve({ sent: false });
  const body = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ sent: res.statusCode >= 200 && res.statusCode < 300, response: data.slice(0, 300) }));
    });
    req.on('error', (error) => resolve({ sent: false, error: error.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ sent: false, error: 'telegram_timeout' }); });
    req.write(body);
    req.end();
  });
}

function latestPrice(history) {
  const candle = history?.candles?.[history.candles.length - 1];
  return Number(candle?.adjustedClose || candle?.close || 0);
}

function buildReportSummary(report, gate) {
  const rows = [
    `📘 RULES SHADOW — ${report.date || 'ไม่ทราบวันที่'}`,
    `พอร์ตเงา: ${Number(report.equity || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท`,
    `เงินสดเงา: ${Number(report.cash || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท`,
    `สถานะ ACTIVE: ${report.shadowPositions} ตัว`,
    `เหตุการณ์ซื้อ/ขายจำลอง: ${report.shadowTradeEvents}`,
    `Decision events วันนี้: ${report.decisionEvents}`,
    `Data quality failures: ${report.dataQualityFailures}`,
    `SET TRI snapshot: ${report.setTriValue ? Number(report.setTriValue).toLocaleString('th-TH') : 'ไม่พร้อม'}`,
    '',
    `Gate 20 วัน: ${gate.passed ? 'ผ่าน' : 'ยังไม่ผ่าน'}`,
    `สะสม ${gate.tradingDays}/${report.minimumShadowDays} วัน | ${gate.decisionEvents}/${report.minimumDecisionEvents} decisions`,
    '🔒 ไม่มีคำสั่งเงินจริงจากฟังก์ชันนี้',
  ];
  if (report.unclassifiedSymbols.length > 0) {
    rows.push('', `ยังเป็น REVIEW: ${report.unclassifiedSymbols.join(', ')}`);
  }
  if (report.evaluations.length > 0) {
    rows.push('', ...report.evaluations.slice(0, 10).map((item) =>
      `• ${item.symbol}: ${item.action} [${item.reasonCodes.slice(0, 3).join(', ')}]`
    ));
  }
  return rows.join('\n');
}

async function runStrategyShadow(event = {}, options = {}) {
  const now = options.now || new Date();
  const researchWindow = isResearchWindow(now);
  if (!researchWindow.allowed && process.env.ALLOW_MANUAL_RESEARCH_OUTSIDE_WINDOW !== 'true' && !options.force) {
    return {
      skipped: true,
      reason: researchWindow.reason,
      date: researchWindow.isoDate,
    };
  }

  const { policy, source: policySource } = await loadEffectivePortfolioPolicy(event);
  const broker = await fetchBrokerPortfolio(event);
  const segmented = segmentPortfolio(broker.portfolio, policy);
  const allocation = summarizeAllocation(segmented, broker.cash, policy);
  const activeSymbols = policy.research?.shadowSymbols || policy.classification.activeSymbols || [];
  const initialCapital = Number(process.env.SHADOW_INITIAL_CAPITAL || 100000);
  const shadowRecord = await getShadowState(event, initialCapital);
  let shadowState = shadowRecord.data;

  let benchmarkHistory = null;
  let benchmarkRegime = { tradable: false, reason: 'BENCHMARK_UNAVAILABLE' };
  let benchmarkError = null;
  try {
    benchmarkHistory = await fetchDailyHistory('^SET.BK', { range: '5y' });
    benchmarkRegime = evaluateBenchmarkRegime(benchmarkHistory.candles, {
      minimumBars: policy.research.minimumBars,
      maxAgeDays: 10,
      now,
    });
  } catch (error) {
    benchmarkError = error.message;
  }

  const evaluations = [];
  const dataFailures = [];
  const priceMap = {};
  const executionPriceMap = {};
  const volumeMap = {};

  for (const symbol of activeSymbols) {
    try {
      const history = await fetchDailyHistory(symbol, { range: '5y' });
      const currentPrice = latestPrice(history);
      if (currentPrice <= 0) throw new Error('LATEST_PRICE_INVALID');
      priceMap[symbol] = currentPrice;
      const latestCandle = history.candles[history.candles.length - 1] || {};
      executionPriceMap[symbol] = Number(latestCandle.open || 0);
      volumeMap[symbol] = Number(latestCandle.volume || 0);
      const corporate = corporateActionGate({
        symbol,
        date: researchWindow.isoDate,
        researchEvents: history.events,
      });
      const hasPosition = Boolean(shadowState.positions?.[symbol]);
      const evaluation = evaluateActiveStrategy(history.candles, {
        minimumBars: policy.research.minimumBars,
        maxAgeDays: 10,
        now,
        hasPosition,
        benchmarkRegime,
      });
      const action = corporate.allowed ? evaluation.action : 'NO_TRADE';
      evaluations.push({
        symbol,
        action,
        price: currentPrice,
        ruleVersion: evaluation.ruleVersion,
        reasonCodes: corporate.allowed
          ? evaluation.reasonCodes
          : [corporate.reason, ...evaluation.reasonCodes],
        features: evaluation.features,
        corporateAction: corporate,
        strategyAuthority: 'RULES_ONLY',
      });
    } catch (error) {
      dataFailures.push({ symbol, error: error.message });
      evaluations.push({
        symbol,
        action: 'NO_TRADE',
        price: 0,
        reasonCodes: [`DATA_FAILURE:${error.message}`],
        strategyAuthority: 'RULES_ONLY',
      });
    }
  }

  shadowState = markToMarket(shadowState, priceMap);
  const applied = applySignals(shadowState, evaluations, {
    date: researchWindow.isoDate,
    priceMap,
    executionPriceMap,
    volumeMap,
    maxPositionWeight: policy.active.maxPositionWeight,
    maxPositions: policy.active.maxPositions,
    boardLot: Number(process.env.PROPOSAL_BOARD_LOT || 100),
    costModel: loadCostModel(),
  });
  shadowState = applied.state;

  const savedState = await saveShadowState(shadowState, event, shadowRecord.etag);

  let setTri = null;
  let setTriError = null;
  try { setTri = await fetchSetTriSnapshot(); }
  catch (error) { setTriError = error.message; }

  const report = {
    date: researchWindow.isoDate,
    marketOpenDay: true,
    policyVersion: policy.schemaVersion,
    policySource,
    strategyVersion: savedState.strategyVersion,
    initialCapital: savedState.initialCapital,
    equity: savedState.equity,
    cash: savedState.cash,
    peakEquity: savedState.peakEquity,
    maxDrawdown: savedState.maxDrawdown,
    shadowPositions: Object.keys(savedState.positions || {}).length,
    shadowTradeEvents: applied.events.filter((item) => item.side === 'BUY' || item.side === 'SELL').length,
    decisionEvents: evaluations.length,
    duplicateIntentAttempts: 0,
    unauthorizedExecutionAttempts: 0,
    dataQualityFailures: dataFailures.length + (benchmarkError ? 1 : 0) + (setTriError ? 1 : 0),
    setTriValue: setTri?.value || null,
    setTriSource: setTri?.source || null,
    benchmarkRegime,
    benchmarkError,
    setTriError,
    evaluations,
    dataFailures,
    allocation,
    unclassifiedSymbols: allocation.violations
      .filter((item) => item.code === 'UNCLASSIFIED_REVIEW_POSITIONS')
      .flatMap((item) => item.symbols || []),
    minimumShadowDays: policy.research.minimumShadowTradingDays,
    minimumDecisionEvents: policy.research.minimumDecisionEvents,
  };

  await saveDailyReport(researchWindow.isoDate, report, event);
  const reports = await listDailyReports(event, 400);
  const gate = evaluateShadowGate(reports, {
    minimumDays: policy.research.minimumShadowTradingDays,
    minimumEvents: policy.research.minimumDecisionEvents,
    minimumTradeEvents: policy.research.minimumShadowTradeEvents,
    maximumDrawdown: policy.research.maximumShadowDrawdown,
    minimumAfterCostReturn: policy.research.minimumAfterCostReturn,
    minimumExcessReturn: policy.research.minimumBenchmarkExcessReturn,
  });

  if (options.sendTelegram !== false) await postTelegram(buildReportSummary(report, gate));

  return {
    skipped: false,
    date: researchWindow.isoDate,
    report,
    gate,
    note: 'Rules-only shadow research; no live orders or order intents are created.',
  };
}

exports.handler = async (event = {}) => {
  try {
    const result = await runStrategyShadow(event, { sendTelegram: true });
    return jsonResponse(200, { ok: true, ...result });
  } catch (error) {
    await postTelegram(`🔴 RULES SHADOW ERROR\n${error.message}`);
    return jsonResponse(500, { ok: false, error: error.message });
  }
};

module.exports.runStrategyShadow = runStrategyShadow;
module.exports._test = { buildReportSummary };
