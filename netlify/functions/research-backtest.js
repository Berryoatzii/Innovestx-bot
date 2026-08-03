const https = require('https');
const { loadEffectivePortfolioPolicy } = require('../lib/effective-portfolio-policy');
const { fetchDailyHistory } = require('../lib/research-market-data');
const { backtestActiveStrategy } = require('../lib/backtest-engine');
const { saveBacktestResult } = require('../lib/research-results-store');

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
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: String(text).slice(0, 4096) });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ sent: res.statusCode >= 200 && res.statusCode < 300 }));
    });
    req.on('error', (error) => resolve({ sent: false, error: error.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ sent: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

async function runResearchBacktests(event = {}, options = {}) {
  const { policy } = await loadEffectivePortfolioPolicy(event);
  const symbols = options.symbols?.length
    ? options.symbols.map((item) => String(item).toUpperCase())
    : policy.classification.activeSymbols || [];
  const results = [];

  if (symbols.length === 0) {
    return { symbols: [], results: [], message: 'NO_ACTIVE_SYMBOLS' };
  }

  const benchmark = await fetchDailyHistory('^SET.BK', { range: '10y' });
  for (const symbol of symbols.slice(0, 10)) {
    try {
      const history = await fetchDailyHistory(symbol, { range: '10y' });
      const result = backtestActiveStrategy(history.candles, benchmark.candles, {
        symbol,
        initialCapital: Number(process.env.BACKTEST_INITIAL_CAPITAL || 100000),
        maxPositionWeight: policy.active.maxPositionWeight,
        boardLot: Number(process.env.PROPOSAL_BOARD_LOT || 100),
        benchmark: 'SET_INDEX_PROXY',
      });
      const stored = await saveBacktestResult(symbol, result, event, {
        minimumTrades: Number(process.env.BACKTEST_MINIMUM_TRADES || 5),
        minimumDecisions: Number(process.env.BACKTEST_MINIMUM_DECISIONS || 100),
        maximumDrawdown: Number(process.env.BACKTEST_MAX_DRAWDOWN || -0.25),
      });
      results.push({ symbol, ok: true, gate: stored.gate, metrics: result.metrics });
    } catch (error) {
      results.push({ symbol, ok: false, error: error.message });
    }
  }

  if (options.sendTelegram !== false) {
    const lines = [
      '🧪 ACTIVE BACKTEST — AFTER COSTS',
      `ACTIVE ที่ทดสอบ: ${results.length} ตัว`,
      'เงื่อนไข: Next-bar execution + commission + fees + VAT + slippage',
      '🔒 ผล Backtest ไม่สร้างออเดอร์จริง',
      '',
    ];
    if (results.length === 0) lines.push('• ยังไม่มีหุ้น ACTIVE');
    for (const row of results) {
      if (!row.ok) {
        lines.push(`🔴 ${row.symbol}: DATA/TEST ERROR — ${row.error}`);
        continue;
      }
      lines.push([
        row.gate.passed ? '🟢' : '🟡',
        `${row.symbol}: ${row.gate.passed ? 'PASS' : 'NOT PASS'}`,
        `Return ${percent(row.metrics.totalReturn)}`,
        `vs SET ${percent(row.metrics.excessVsBenchmark)}`,
        `DD ${percent(row.metrics.maxDrawdown)}`,
        `Trades ${row.metrics.completedTrades}`,
      ].join(' | '));
    }
    await postTelegram(lines.join('\n'));
  }

  return { symbols, results };
}

exports.handler = async (event = {}) => {
  try {
    const result = await runResearchBacktests(event, { sendTelegram: true });
    return jsonResponse(200, { ok: true, ...result });
  } catch (error) {
    await postTelegram(`🔴 BACKTEST ERROR\n${error.message}`);
    return jsonResponse(500, { ok: false, error: error.message });
  }
};

module.exports.runResearchBacktests = runResearchBacktests;
