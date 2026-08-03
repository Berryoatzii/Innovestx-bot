// Scheduled AI advisory only.
// This function may analyze and explain, but can never create order intents or reach the broker.

const https = require('https');
const crypto = require('crypto');
const { runAutoTrader: runEngine } = require('../lib/autotrade-engine');

const VALID_MODES = new Set(['analyze', 'dry_run']);
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

  const payload = {
    chat_id: TG_CHAT_ID,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
  };
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

function summarizeAdvisory(result) {
  const simulated = (result.orders_placed || []).filter((order) => order.orderId === 'SIMULATE');
  const failed = result.orders_failed || [];
  return {
    observations: simulated.slice(0, 10).map((order) => ({
      symbol: String(order.sym || '').toUpperCase(),
      side: String(order.side || 'SELL').toUpperCase(),
      quantityObserved: Number(order.qty || 0),
      referencePrice: Number(order.mkt || 0),
      reason: order.reason || null,
      grade: order.grade || null,
      finalScore: order.final_score ?? null,
      authority: 'ADVISORY_ONLY',
    })),
    failedCount: failed.length,
  };
}

async function runAutoTrader(mode = 'dry_run', portfolioOverride = null) {
  if (String(mode).toLowerCase() === 'execute') {
    throw new Error('DIRECT_EXECUTE_DISABLED_AI_HAS_NO_ORDER_AUTHORITY');
  }
  return runEngine(normalizeMode(mode), portfolioOverride);
}

exports.handler = async () => {
  const runId = crypto.randomUUID().slice(0, 8);
  const requested = process.env.SCHEDULED_TRADE_MODE || 'dry_run';
  const mode = normalizeMode(requested);

  console.log(`[AI Advisory] run=${runId} mode=${mode}`);
  await postTelegram([
    `🟡 AI ADVISORY START [${runId}]`,
    `เวลา: ${bkkTimestamp()}`,
    'สถานะ: กำลังอ่านพอร์ตเพื่อสร้างข้อสังเกตเท่านั้น',
    '🔒 AI ไม่มีสิทธิ์สร้าง Order Intent หรือส่งคำสั่งซื้อขาย',
  ].join('\n'));

  try {
    const result = await runAutoTrader(mode, null);
    const advisory = summarizeAdvisory(result);
    const lines = [
      `🟢 AI ADVISORY DONE [${runId}]`,
      `เวลา: ${bkkTimestamp()}`,
      `ตรวจแล้ว: ${(result.analyzed || []).length} หุ้น`,
      `ข้อสังเกต: ${advisory.observations.length} รายการ`,
      `Engine errors: ${advisory.failedCount}`,
      '',
      '⚠️ รายการต่อไปนี้ไม่ใช่ออเดอร์และกดอนุมัติไม่ได้',
    ];

    if (advisory.observations.length === 0) {
      lines.push('• ไม่มีข้อสังเกตในรอบนี้');
    } else {
      lines.push(...advisory.observations.map((item) =>
        `• ${item.symbol}: ${item.side} (AI observation only) ${item.reason || ''}`
      ));
    }

    await postTelegram(lines.join('\n'));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: true,
        runId,
        mode: result.mode,
        analyzed: (result.analyzed || []).length,
        advisory,
        orderIntentsCreated: 0,
        liveOrdersPlaced: 0,
      }),
    };
  } catch (error) {
    await postTelegram([
      `🔴 AI ADVISORY ERROR [${runId}]`,
      `เวลา: ${bkkTimestamp()}`,
      `สาเหตุ: ${error.message}`,
      'ไม่มี Order Intent และไม่มีคำสั่งจริงจากรอบนี้',
    ].join('\n'));
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, runId, mode, error: error.message }),
    };
  }
};

module.exports.runAutoTrader = runAutoTrader;
module.exports._test = { normalizeMode, summarizeAdvisory };
