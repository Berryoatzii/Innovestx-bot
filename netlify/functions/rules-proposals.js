const https = require('https');
const { handler: invxHandler } = require('./invx');
const { fetchBrokerPortfolio } = require('../lib/broker-portfolio');
const { loadEffectivePortfolioPolicy } = require('../lib/effective-portfolio-policy');
const { buildBotReadiness } = require('../lib/bot-readiness');
const { getBacktestResult } = require('../lib/research-results-store');
const { fetchDailyHistory } = require('../lib/research-market-data');
const { evaluateActiveStrategy, evaluateBenchmarkRegime } = require('../lib/deterministic-strategy');
const { corporateActionGate } = require('../lib/corporate-action-gate');
const { isSetTradingDay, bkkDateParts } = require('../lib/market-calendar');
const {
  calculateProposalQuantity,
  calculateBuyProposalQuantity,
  createIntent,
} = require('../lib/order-intent-store');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

function postTelegram(text, keyboard = null) {
  if (!TG_TOKEN || !TG_CHAT_ID) return Promise.resolve({ sent: false });
  const payload = { chat_id: TG_CHAT_ID, text: String(text).slice(0, 4096) };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ sent: res.statusCode >= 200 && res.statusCode < 300 }));
    });
    req.on('error', (error) => resolve({ sent: false, error: error.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ sent: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function fetchQuote(symbol, event) {
  const response = await invxHandler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { action: 'quote', sym: symbol },
    body: '',
    requestContext: event?.requestContext,
  });
  let payload = {};
  try { payload = JSON.parse(response.body || '{}'); }
  catch { throw new Error('QUOTE_INVALID_JSON'); }
  if (response.statusCode !== 200 || Number(payload.last || 0) <= 0) {
    throw new Error(`QUOTE_NOT_READY:${response.statusCode}:${payload.error || 'NO_LAST'}`);
  }
  return payload;
}

function totalPortfolioValue(portfolio, cash) {
  return Number(cash || 0) + (Array.isArray(portfolio) ? portfolio : []).reduce((sum, item) => {
    return sum + Number(item.qty || 0) * Number(item.mkt || 0);
  }, 0);
}

function sessionName(date = new Date()) {
  const { minutes } = bkkDateParts(date);
  return minutes < 13 * 60 ? 'AM' : 'PM';
}

async function runRulesProposals(event = {}, options = {}) {
  const now = options.now || new Date();
  const tradingDay = isSetTradingDay(now);
  if (!tradingDay.openDay) {
    return { skipped: true, reason: tradingDay.reason, intents: [] };
  }

  const readiness = await buildBotReadiness(event);
  if (!readiness.stages.proposalReady) {
    return {
      skipped: true,
      reason: 'PROPOSAL_GATE_NOT_READY',
      blockers: readiness.blockers,
      intents: [],
    };
  }

  const { policy } = await loadEffectivePortfolioPolicy(event);
  const broker = await fetchBrokerPortfolio(event);
  const benchmark = await fetchDailyHistory('^SET.BK', { range: '5y' });
  const benchmarkRegime = evaluateBenchmarkRegime(benchmark.candles, {
    minimumBars: policy.research.minimumBars,
    maxAgeDays: 10,
    now,
  });

  const intents = [];
  const skipped = [];
  const date = tradingDay.isoDate;
  const session = sessionName(now);
  const boardLot = Number(process.env.PROPOSAL_BOARD_LOT || 100);
  const maxOrderValue = Number(process.env.PROPOSAL_MAX_ORDER_VALUE || 3000);
  const portfolioValue = totalPortfolioValue(broker.portfolio, broker.cash);
  const cashReserve = Math.max(
    Number(process.env.PROPOSAL_MIN_CASH_RESERVE || 5000),
    portfolioValue * Number(policy.targets.CASH || 0.20)
  );

  for (const symbol of (policy.classification.activeSymbols || []).slice(0, 10)) {
    try {
      const backtest = await getBacktestResult(symbol, event);
      if (!backtest?.gate?.passed) {
        skipped.push({ symbol, reason: 'BACKTEST_NOT_PASSED' });
        continue;
      }

      const position = broker.portfolio.find((item) => String(item.sym || '').toUpperCase() === symbol);
      const history = await fetchDailyHistory(symbol, { range: '5y' });
      const evaluation = evaluateActiveStrategy(history.candles, {
        minimumBars: policy.research.minimumBars,
        maxAgeDays: 10,
        now,
        hasPosition: Boolean(position),
        benchmarkRegime,
      });
      const corporate = corporateActionGate({ symbol, date, researchEvents: history.events });
      if (!corporate.allowed) {
        skipped.push({ symbol, reason: corporate.reason });
        continue;
      }

      let side = null;
      if (!position && evaluation.action === 'BUY_CANDIDATE') side = 'BUY';
      if (position && evaluation.action === 'EXIT_REVIEW') side = 'SELL';
      if (!side) {
        skipped.push({ symbol, reason: evaluation.action });
        continue;
      }

      const quote = await fetchQuote(symbol, event);
      const proposedPrice = side === 'BUY'
        ? Number(quote.ask || quote.last)
        : Number(quote.bid || quote.last);
      if (proposedPrice <= 0) throw new Error('PROPOSED_PRICE_INVALID');

      const portfolioQty = Math.floor(Number(position?.qty || 0));
      const quantity = side === 'BUY'
        ? calculateBuyProposalQuantity({
            cash: broker.cash,
            price: proposedPrice,
            maxOrderValue,
            cashReserve,
            boardLot,
          })
        : calculateProposalQuantity({
            positionQty: portfolioQty,
            price: proposedPrice,
            maxFraction: Number(process.env.PROPOSAL_MAX_POSITION_FRACTION || 0.25),
            maxOrderValue,
            boardLot,
          });

      if (quantity <= 0) {
        skipped.push({ symbol, reason: `${side}_SIZE_NOT_SAFE` });
        continue;
      }

      const idempotencyKey = [
        date,
        session,
        symbol,
        side,
        evaluation.ruleVersion,
      ].join('|');
      const reason = evaluation.reasonCodes.join(', ');
      const { intent, created } = await createIntent({
        idempotencyKey,
        symbol,
        side,
        quantity,
        proposedPrice,
        portfolioQty,
        portfolioBucket: 'ACTIVE',
        strategyVersion: evaluation.ruleVersion,
        reasonCode: side === 'BUY' ? 'ACTIVE_RULES_ENTRY' : 'ACTIVE_RULES_EXIT',
        reason,
        modelAuthority: 'ADVISORY_ONLY',
        decisionAuthority: 'DETERMINISTIC_RULES_PLUS_HUMAN_APPROVAL',
        source: 'rules-proposals',
      }, {
        event,
        ttlMinutes: Number(process.env.ORDER_INTENT_TTL_MINUTES || 90),
      });

      intents.push(intent);
      if (created && options.sendTelegram !== false) {
        await postTelegram([
          `🟠 RULES PROPOSAL [${intent.id}]`,
          `${intent.side} ${intent.symbol} ${intent.quantity} หุ้น`,
          `ราคาอ้างอิง Settrade: ${Number(intent.proposedPrice).toFixed(2)}`,
          `มูลค่าโดยประมาณ: ${Number(intent.estimatedValue).toLocaleString('th-TH')} บาท`,
          `Rules: ${intent.reason}`,
          `Backtest: PASS | Shadow: PASS`,
          '',
          'กดอนุมัติแล้วระบบจะตรวจราคา พอร์ต เงินสด Spread และออเดอร์ซ้ำอีกครั้ง',
        ].join('\n'), [
          [{ text: `✅ ตรวจและอนุมัติ ${intent.symbol}`, callback_data: `APV:${intent.id}` }],
          [{ text: `❌ ปฏิเสธ ${intent.symbol}`, callback_data: `REJ:${intent.id}` }],
        ]);
      }
    } catch (error) {
      skipped.push({ symbol, reason: error.message });
    }
  }

  return { skipped: false, date, session, intents, filtered: skipped };
}

exports.handler = async (event = {}) => {
  try {
    const result = await runRulesProposals(event, { sendTelegram: true });
    return jsonResponse(200, { ok: true, ...result });
  } catch (error) {
    await postTelegram(`🔴 RULES PROPOSAL ERROR\n${error.message}`);
    return jsonResponse(500, { ok: false, error: error.message });
  }
};

module.exports.runRulesProposals = runRulesProposals;
module.exports._test = { totalPortfolioValue, sessionName };
