// Scheduled AI advisory only.
// AI may surface observations, but deterministic data/risk logic builds the action plan.
// This function creates zero order intents and can never reach the live-order path.

const https = require('https');
const crypto = require('crypto');
const { runAutoTrader: runEngine } = require('../lib/autotrade-engine');
const { buildActionPlan, formatActionPlan } = require('../lib/portfolio-action-plan');

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
  const analyzedMap = Object.fromEntries((result.analyzed || []).map((item) => [item.sym, item]));
  const observations = simulated.slice(0, 5).map((order) => {
    const analyzed = analyzedMap[order.sym] || {};
    return {
      symbol: String(order.sym || '').toUpperCase(),
      sym: String(order.sym || '').toUpperCase(),
      side: String(order.side || 'SELL').toUpperCase(),
      quantityObserved: Number(order.qty || 0),
      qty: Number(order.qty || 0),
      avg: Number(analyzed.avg || 0),
      pnlPct: Number(analyzed.pnlPct ?? order.pnlPct ?? 0),
      referencePrice: Number(order.mkt || analyzed.mkt || 0),
      mkt: Number(order.mkt || analyzed.mkt || 0),
      reason: order.reason || analyzed.reason_th || null,
      grade: order.grade || analyzed.grade || null,
      finalScore: order.final_score ?? analyzed.final_score ?? null,
      authority: 'ADVISORY_ONLY',
      orderId: 'SIMULATE',
    };
  });
  return {
    observations,
    simulated: observations,
    failedCount: failed.length,
  };
}

async function buildPlans(observations, event) {
  const plans = [];
  for (const observation of observations.slice(0, 3)) {
    try {
      plans.push(await buildActionPlan(observation, event));
    } catch (error) {
      plans.push({
        symbol: observation.symbol,
        error: error.message,
        liveOrderCreated: false,
      });
    }
  }
  return plans;
}

async function runAutoTrader(mode = 'dry_run', portfolioOverride = null) {
  if (String(mode).toLowerCase() === 'execute') {
    throw new Error('DIRECT_EXECUTE_DISABLED_USE_HUMAN_APPROVAL:AI_HAS_NO_ORDER_AUTHORITY');
  }
  return runEngine(normalizeMode(mode), portfolioOverride);
}

exports.handler = async (event = {}) => {
  const runId = crypto.randomUUID().slice(0, 8);
  const requested = process.env.SCHEDULED_TRADE_MODE || 'dry_run';
  const mode = normalizeMode(requested);

  console.log(`[AI Advisory] run=${runId} mode=${mode}`);
  await postTelegram([
    `🟡 AI ADVISORY START [${runId}]`,
    `เวลา: ${bkkTimestamp()}`,
    'สถานะ: กำลังอ่านพอร์ต ราคา กราฟ และข้อมูลมูลค่าที่ตรวจยืนยันได้',
    '🔒 AI ไม่มีสิทธิ์สร้าง Order Intent หรือส่งคำสั่งซื้อขาย',
  ].join('\n'));

  try {
    const result = await runAutoTrader(mode, null);
    const advisory = summarizeAdvisory(result);
    const plans = await buildPlans(advisory.observations, event);

    const lines = [
      `🟢 AI ADVISORY DONE [${runId}]`,
      `เวลา: ${bkkTimestamp()}`,
      `ตรวจแล้ว: ${(result.analyzed || []).length} หุ้น`,
      `ข้อสังเกตจาก AI: ${advisory.observations.length} รายการ`,
      `Decision plans: ${plans.filter((item) => !item.error).length} รายการ`,
      `Engine errors: ${advisory.failedCount}`,
      '',
      '⚠️ AI เป็นเพียงตัวคัดสัญญาณ จำนวนและราคาใช้กฎตลาด/กราฟ/มูลค่า และยังไม่ใช่ออเดอร์',
    ];
    await postTelegram(lines.join('\n'));

    if (plans.length === 0) {
      await postTelegram('✅ รอบนี้ไม่มีหุ้นที่ต้องจัดทำแผนขาย');
    } else {
      for (const plan of plans) {
        if (plan.error) {
          await postTelegram(`🔴 PLAN ERROR — ${plan.symbol}\n${plan.error}\nไม่มีออเดอร์ถูกสร้าง`);
        } else {
          await postTelegram(formatActionPlan(plan));
        }
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: true,
        runId,
        mode: result.mode,
        analyzed: (result.analyzed || []).length,
        advisory,
        plans,
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
module.exports._test = {
  normalizeMode,
  summarizeAdvisory,
  summarizeSignals: summarizeAdvisory,
  buildPlans,
};