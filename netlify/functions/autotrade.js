// Safe entry point for scheduled and manual auto-trading.
// The trading engine lives outside the deployable functions folder.
// This wrapper owns safety locks and operator visibility.

const https = require('https');
const crypto = require('crypto');
const { runAutoTrader: runEngine } = require('../lib/autotrade-engine');

const VALID_MODES = new Set(['analyze', 'dry_run', 'execute']);
const LIVE_TRADING_ENABLED = process.env.LIVE_TRADING_ENABLED === 'true';
const SCHEDULED_LIVE_TRADING_ENABLED = process.env.SCHEDULED_LIVE_TRADING_ENABLED === 'true';
const TELEGRAM_PROGRESS_ENABLED = process.env.TELEGRAM_PROGRESS_ENABLED !== 'false';
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function normalizeMode(mode) {
  return VALID_MODES.has(mode) ? mode : 'dry_run';
}

function bkkTimestamp() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function postTelegram(text) {
  if (!TELEGRAM_PROGRESS_ENABLED || !TG_TOKEN || !TG_CHAT_ID) {
    return Promise.resolve({ sent: false, reason: 'telegram_not_configured' });
  }

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
      res.on('end', () => resolve({
        sent: res.statusCode >= 200 && res.statusCode < 300,
        statusCode: res.statusCode,
        response: data.slice(0, 300),
      }));
    });

    req.on('error', (error) => resolve({ sent: false, reason: error.message }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ sent: false, reason: 'telegram_timeout' });
    });
    req.write(body);
    req.end();
  });
}

function summarizeSignals(result) {
  const simulated = (result.orders_placed || []).filter((order) => order.orderId === 'SIMULATE');
  const executed = (result.orders_placed || []).filter((order) => order.orderId !== 'SIMULATE');
  const failed = result.orders_failed || [];

  const actionSource = executed.length > 0 ? executed : simulated;
  const actionLabel = executed.length > 0 ? 'ส่งคำสั่งแล้ว' : 'Shadow Signal';
  const topActions = actionSource.slice(0, 5).map((order) => {
    const priceText = Number(order.mkt) > 0 ? ` @ ${Number(order.mkt).toFixed(2)}` : '';
    return `${order.side || 'SELL'} ${order.sym} ${order.qty || 0} หุ้น${priceText}`;
  });

  return {
    actionLabel,
    topActions,
    executedCount: executed.length,
    simulatedCount: simulated.length,
    failedCount: failed.length,
  };
}

async function runAutoTrader(mode = 'dry_run', portfolioOverride = null) {
  const safeMode = normalizeMode(mode);

  // Fail closed: no caller may execute real orders unless the global live lock is enabled.
  if (safeMode === 'execute' && !LIVE_TRADING_ENABLED) {
    throw new Error('Live trading is locked: LIVE_TRADING_ENABLED is not true');
  }

  // Never trust browser-provided positions for real orders.
  const safePortfolioOverride = safeMode === 'execute' ? null : portfolioOverride;
  return runEngine(safeMode, safePortfolioOverride);
}

exports.handler = async () => {
  const runId = crypto.randomUUID().slice(0, 8);
  let mode = normalizeMode(process.env.SCHEDULED_TRADE_MODE || 'dry_run');

  // Scheduled real-money execution needs a second independent server-side lock.
  if (mode === 'execute' && !SCHEDULED_LIVE_TRADING_ENABLED) {
    console.warn('[AutoTrader] Scheduled execute requested but locked; falling back to dry_run');
    mode = 'dry_run';
  }

  console.log(`[AutoTrader] Safe scheduled run | run=${runId} mode=${mode}`);

  await postTelegram([
    `🟡 BOT START [${runId}]`,
    `เวลา: ${bkkTimestamp()}`,
    `โหมด: ${mode.toUpperCase()}`,
    'สถานะ: กำลังดึงพอร์ตและวิเคราะห์สัญญาณ',
    mode === 'execute' ? '⚠️ โหมดเงินจริง' : '🔒 ไม่มีการส่งคำสั่งเงินจริง',
  ].join('\n'));

  try {
    const result = await runAutoTrader(mode, null);
    const signal = summarizeSignals(result);
    const lines = [
      `🟢 BOT DONE [${runId}]`,
      `เวลา: ${bkkTimestamp()}`,
      `โหมด: ${result.mode.toUpperCase()}`,
      `ตรวจแล้ว: ${(result.analyzed || []).length} หุ้น`,
      `${signal.actionLabel}: ${signal.executedCount + signal.simulatedCount} รายการ`,
      `ผิดพลาด: ${signal.failedCount} รายการ`,
    ];

    if (signal.topActions.length > 0) {
      lines.push('', ...signal.topActions.map((item) => `• ${item}`));
    } else {
      lines.push('', '• รอบนี้ยังไม่มีสัญญาณที่ผ่านเกณฑ์');
    }

    if (result.summary) {
      lines.push('', `สรุป: ${String(result.summary).slice(0, 1200)}`);
    }

    await postTelegram(lines.join('\n'));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: true,
        runId,
        mode: result.mode,
        timestamp: result.timestamp,
        analyzed: (result.analyzed || []).length,
        simulated_or_placed: result.orders_placed.length,
        failed: result.orders_failed.length,
        summary: result.summary,
      }),
    };
  } catch (err) {
    console.error(`[AutoTrader] Safe wrapper failure | run=${runId}:`, err);

    await postTelegram([
      `🔴 BOT ERROR [${runId}]`,
      `เวลา: ${bkkTimestamp()}`,
      `โหมด: ${mode.toUpperCase()}`,
      `สาเหตุ: ${err.message}`,
      'สถานะ: ไม่มีการส่งคำสั่งเพิ่มจากรอบนี้',
    ].join('\n'));

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, runId, mode, error: err.message }),
    };
  }
};

module.exports.runAutoTrader = runAutoTrader;
module.exports._test = { normalizeMode, summarizeSignals };
