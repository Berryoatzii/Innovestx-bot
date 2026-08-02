// Safe entry point for scheduled analysis.
// Direct execution is disabled: only approved order intents may reach the broker.

const https = require('https');
const crypto = require('crypto');
const { runAutoTrader: runEngine } = require('../lib/autotrade-engine');
const {
  initializeBlobContext,
  calculateProposalQuantity,
  createIntent,
} = require('../lib/order-intent-store');

const VALID_MODES = new Set(['analyze', 'dry_run']);
const TELEGRAM_PROGRESS_ENABLED = process.env.TELEGRAM_PROGRESS_ENABLED !== 'false';
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function normalizeMode(mode) {
  return VALID_MODES.has(mode) ? mode : 'dry_run';
}

function bkkDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: String(shifted.getUTCHours()).padStart(2, '0'),
  };
}

function bkkTimestamp() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

function postTelegram(text, keyboard = null) {
  if (!TELEGRAM_PROGRESS_ENABLED || !TG_TOKEN || !TG_CHAT_ID) {
    return Promise.resolve({ sent: false, reason: 'telegram_not_configured' });
  }

  const payload = {
    chat_id: TG_CHAT_ID,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  const body = JSON.stringify(payload);

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

function parseCoreSymbols() {
  return new Set(String(process.env.CORE_SYMBOLS || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean));
}

function summarizeSignals(result) {
  const simulated = (result.orders_placed || []).filter((order) => order.orderId === 'SIMULATE');
  const failed = result.orders_failed || [];
  return {
    simulated,
    failedCount: failed.length,
  };
}

async function createApprovalIntents(result, runId, event) {
  const maxFraction = Number(process.env.PROPOSAL_MAX_POSITION_FRACTION || 0.25);
  const maxOrderValue = Number(process.env.PROPOSAL_MAX_ORDER_VALUE || 3000);
  const boardLot = Number(process.env.PROPOSAL_BOARD_LOT || 100);
  const ttlMinutes = Number(process.env.ORDER_INTENT_TTL_MINUTES || 45);
  const coreSymbols = parseCoreSymbols();
  const { date, hour } = bkkDateParts();
  const intents = [];
  const skipped = [];

  const simulated = (result.orders_placed || []).filter((order) => order.orderId === 'SIMULATE');
  for (const order of simulated.slice(0, 5)) {
    const symbol = String(order.sym || '').toUpperCase();
    const side = String(order.side || 'SELL').toUpperCase();
    const price = Number(order.mkt || 0);
    const portfolioQty = Math.floor(Number(order.qty || 0));

    if (coreSymbols.has(symbol)) {
      skipped.push({ symbol, reason: 'CORE_PROTECTED' });
      continue;
    }

    const quantity = calculateProposalQuantity({
      positionQty: portfolioQty,
      price,
      maxFraction,
      maxOrderValue,
      boardLot,
    });

    if (quantity <= 0) {
      skipped.push({ symbol, reason: 'PROPOSAL_SIZE_NOT_SAFE' });
      continue;
    }

    const idempotencyKey = [
      date,
      hour,
      runId,
      symbol,
      side,
      quantity,
      'shadow-advisory-v1',
    ].join('|');

    try {
      const { intent, created } = await createIntent({
        idempotencyKey,
        symbol,
        side,
        quantity,
        proposedPrice: price,
        portfolioQty,
        portfolioBucket: 'REVIEW',
        strategyVersion: 'shadow-advisory-v1',
        runId,
        reasonCode: 'AI_ADVISORY_REVIEW',
        reason: order.reason || `Grade=${order.grade || '-'} Score=${order.final_score || '-'}`,
        source: 'scheduled-shadow',
      }, { event, ttlMinutes });

      intents.push(intent);

      if (created) {
        await postTelegram([
          `🟠 ORDER PROPOSAL [${intent.id}]`,
          `ข้อเสนอ: ${intent.side} ${intent.symbol} ${intent.quantity} หุ้น`,
          `ราคาอ้างอิง: ${Number(intent.proposedPrice).toFixed(2)}`,
          `มูลค่าโดยประมาณ: ${Number(intent.estimatedValue).toLocaleString('th-TH')} บาท`,
          `สัดส่วน: ไม่เกิน ${Math.round(maxFraction * 100)}% ของสถานะ และไม่ขายหมด`,
          `หมดอายุ: ${intent.expiresAt}`,
          '',
          `เหตุผล: ${intent.reason || 'รอตรวจสอบ'}`,
          '',
          '⚠️ AI เป็นเพียงผู้เสนอ ระบบจะตรวจพอร์ต ราคา สภาพคล่อง วงเงิน และออเดอร์ซ้ำอีกครั้งหลังโอ๊ดกดอนุมัติ',
        ].join('\n'), [
          [{ text: `✅ ตรวจและอนุมัติ ${intent.symbol}`, callback_data: `APV:${intent.id}` }],
          [{ text: `❌ ปฏิเสธ ${intent.symbol}`, callback_data: `REJ:${intent.id}` }],
        ]);
      }
    } catch (error) {
      skipped.push({ symbol, reason: error.message });
    }
  }

  return { intents, skipped };
}

async function runAutoTrader(mode = 'dry_run', portfolioOverride = null) {
  const safeMode = normalizeMode(mode);
  // Live orders may only be created by approval-executor from a signed intent.
  if (String(mode).toLowerCase() === 'execute') {
    throw new Error('DIRECT_EXECUTE_DISABLED_USE_HUMAN_APPROVAL');
  }
  return runEngine(safeMode, portfolioOverride);
}

exports.handler = async (event = {}) => {
  await initializeBlobContext(event);
  const runId = crypto.randomUUID().slice(0, 8);
  const requested = process.env.SCHEDULED_TRADE_MODE || 'dry_run';
  const mode = normalizeMode(requested);

  if (String(requested).toLowerCase() === 'execute') {
    console.warn('[AutoTrader] Scheduled execute is permanently disabled; using dry_run');
  }

  console.log(`[AutoTrader] Scheduled shadow run | run=${runId} mode=${mode}`);
  await postTelegram([
    `🟡 BOT START [${runId}]`,
    `เวลา: ${bkkTimestamp()}`,
    `โหมด: ${mode.toUpperCase()}`,
    'สถานะ: กำลังดึงพอร์ตและวิเคราะห์ข้อเสนอ',
    '🔒 ไม่มีการส่งคำสั่งจริงโดยอัตโนมัติ',
  ].join('\n'));

  try {
    const result = await runAutoTrader(mode, null);
    const signal = summarizeSignals(result);
    const approval = await createApprovalIntents(result, runId, event);

    const lines = [
      `🟢 BOT DONE [${runId}]`,
      `เวลา: ${bkkTimestamp()}`,
      `ตรวจแล้ว: ${(result.analyzed || []).length} หุ้น`,
      `Shadow signals: ${signal.simulated.length} รายการ`,
      `ส่งให้อนุมัติ: ${approval.intents.length} รายการ`,
      `ข้ามเพราะ Safety Gate: ${approval.skipped.length} รายการ`,
      `ผิดพลาดจาก Engine: ${signal.failedCount} รายการ`,
    ];

    if (approval.intents.length === 0) {
      lines.push('', '• รอบนี้ไม่มีข้อเสนอที่ผ่านเกณฑ์ขนาดเบื้องต้น');
    } else {
      lines.push('', ...approval.intents.map((item) =>
        `• รออนุมัติ ${item.side} ${item.symbol} ${item.quantity}หุ้น [${item.id}]`
      ));
    }

    if (approval.skipped.length > 0) {
      lines.push('', ...approval.skipped.slice(0, 5).map((item) => `• ข้าม ${item.symbol}: ${item.reason}`));
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
        shadowSignals: signal.simulated.length,
        approvalIntentIds: approval.intents.map((item) => item.id),
        skipped: approval.skipped,
      }),
    };
  } catch (err) {
    console.error(`[AutoTrader] Shadow wrapper failure | run=${runId}:`, err);
    await postTelegram([
      `🔴 BOT ERROR [${runId}]`,
      `เวลา: ${bkkTimestamp()}`,
      `สาเหตุ: ${err.message}`,
      'สถานะ: ไม่มีการส่งคำสั่งจริงจากรอบนี้',
    ].join('\n'));
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, runId, mode, error: err.message }),
    };
  }
};

module.exports.runAutoTrader = runAutoTrader;
module.exports._test = { normalizeMode, summarizeSignals, bkkDateParts, parseCoreSymbols };
