const https = require('https');
const { fetchBrokerPortfolio } = require('../lib/broker-portfolio');
const {
  classificationMap,
  summarizeClassifications,
  suggestBucket,
  setClassification,
  savePortfolioSnapshot,
} = require('../lib/portfolio-classification-store');
const { runRulesProposals } = require('./rules-proposals');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const EASY_VERSION = 'EASY_APPROVAL_V1.0.0';

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

function tgPost(method, data) {
  if (!TG_TOKEN) return Promise.resolve({ ok: false, description: 'TELEGRAM_TOKEN missing' });
  const body = JSON.stringify(data);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let payload = '';
      res.on('data', (chunk) => { payload += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(payload)); }
        catch { resolve({ ok: false, description: `HTTP ${res.statusCode}` }); }
      });
    });
    req.on('error', (error) => resolve({ ok: false, description: error.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, description: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function tgSend(text, keyboard = null) {
  if (!TG_CHAT_ID) return { ok: false, description: 'TELEGRAM_CHAT_ID missing' };
  const payload = {
    chat_id: TG_CHAT_ID,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return tgPost('sendMessage', payload);
}

function baseUrl() {
  const value = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
  return String(value).replace(/\/$/, '');
}

function easyCommands() {
  return [
    { command: 'easy', description: 'โหมดง่าย ให้บอทแนะนำแล้วกดยืนยัน' },
    { command: 'portfolio', description: 'ดูพอร์ตและเงินสดล่าสุด' },
    { command: 'pending', description: 'ดูคำแนะนำที่รอยืนยัน' },
    { command: 'readiness', description: 'ดูความพร้อมของระบบ' },
    { command: 'advanced', description: 'เปิดเมนูขั้นสูง' },
  ];
}

async function configureEasyTelegram() {
  const url = baseUrl();
  if (!url || !WEBHOOK_SECRET) {
    return { ok: false, description: 'URL or TELEGRAM_WEBHOOK_SECRET missing' };
  }
  const webhook = await tgPost('setWebhook', {
    url: `${url}/.netlify/functions/easy-telegram`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
    max_connections: 5,
  });
  const menu = await tgPost('setMyCommands', {
    commands: easyCommands(),
    scope: { type: 'chat', chat_id: Number(TG_CHAT_ID) },
    language_code: 'th',
  });
  return { ok: Boolean(webhook.ok && menu.ok), webhook, menu };
}

function buildRecommendations(portfolio, map) {
  const summary = summarizeClassifications(portfolio, map);
  const pending = summary.rows.filter((item) => !item.explicit).map((item) => {
    const suggestion = suggestBucket(item.symbol);
    return {
      symbol: item.symbol,
      bucket: suggestion.bucket,
      source: suggestion.source,
      sourceDate: suggestion.sourceDate,
    };
  });
  const counts = { CORE: 0, ACTIVE: 0, REVIEW: 0 };
  for (const item of pending) counts[item.bucket] += 1;
  return { summary, pending, counts };
}

function recommendationText(recommendation) {
  const examples = recommendation.pending.slice(0, 8)
    .map((item) => `${item.symbol}→${item.bucket}`)
    .join(', ');
  return [
    '✨ EASY MODE — ตั้งค่าครั้งเดียว',
    `หุ้นในพอร์ต: ${recommendation.summary.rows.length} ตัว`,
    `ยังไม่ได้ยืนยันหมวด: ${recommendation.pending.length} ตัว`,
    '',
    'บอทแนะนำให้จัดเป็น:',
    `🏛 CORE ${recommendation.counts.CORE} ตัว — ถือยาว/พื้นฐาน/ปันผล`,
    `⚡ ACTIVE ${recommendation.counts.ACTIVE} ตัว — ซื้อขายเป็นรอบ`,
    `📝 REVIEW ${recommendation.counts.REVIEW} ตัว — ข้อมูลยังไม่พอ ห้ามซื้อขาย`,
    examples ? `ตัวอย่าง: ${examples}` : '',
    '',
    'การยืนยันนี้เป็นเพียงการจัดหมวดการทำงาน ไม่ใช่คำสั่งซื้อขาย',
    'หลังยืนยัน บอทจะวิเคราะห์เองและส่งเฉพาะรายการที่ผ่านกฎมาให้กด “ยืนยัน” หรือ “ไม่ทำ”',
  ].filter(Boolean).join('\n');
}

async function applyRecommendations(event = {}, actor = 'telegram-owner') {
  const broker = await fetchBrokerPortfolio(event);
  await savePortfolioSnapshot(broker.portfolio, broker.cash, event);
  const map = await classificationMap(event);
  const recommendation = buildRecommendations(broker.portfolio, map);
  const applied = [];
  const failed = [];

  for (const item of recommendation.pending) {
    try {
      const saved = await setClassification(item.symbol, item.bucket, {
        event,
        actor,
        note: `Easy Mode bulk confirmation; suggestion source=${item.source}`,
      });
      applied.push(saved);
    } catch (error) {
      failed.push({ symbol: item.symbol, error: error.message });
    }
  }

  return {
    recommendation,
    applied,
    failed,
    complete: failed.length === 0,
  };
}

async function runEasyAdvisor(event = {}, options = {}) {
  const broker = await fetchBrokerPortfolio(event);
  await savePortfolioSnapshot(broker.portfolio, broker.cash, event);
  const map = await classificationMap(event);
  const recommendation = buildRecommendations(broker.portfolio, map);
  const sendMessages = options.sendMessages !== false;

  if (recommendation.pending.length > 0) {
    if (sendMessages) {
      await tgSend(recommendationText(recommendation), [
        [{ text: '✅ ใช้แผนที่บอทแนะนำทั้งพอร์ต', callback_data: 'EASY:APPLY' }],
        [{ text: '🔍 ดูและแก้เองทีละตัว', callback_data: 'EASY:DETAIL' }],
      ]);
    }
    return {
      stage: 'CLASSIFICATION_CONFIRMATION_REQUIRED',
      recommendation,
      proposals: null,
    };
  }

  const proposals = await runRulesProposals(event, { sendTelegram: sendMessages });
  if (sendMessages && (!proposals.intents || proposals.intents.length === 0)) {
    await tgSend([
      '✅ EASY MODE กำลังทำงาน',
      'พอร์ตจัดหมวดครบแล้ว และบอทเฝ้าตลาดให้อัตโนมัติ',
      proposals.skipped
        ? `ตอนนี้ยังไม่มีรายการพร้อมยืนยัน: ${proposals.reason}`
        : 'รอบนี้ไม่มีรายการที่ผ่านกฎซื้อขาย',
      '',
      'เมื่อมีรายการที่ผ่าน Backtest, Shadow, Risk และราคาตลาด บอทจะส่งปุ่มยืนยันมาเอง',
    ].join('\n'));
  }
  return {
    stage: 'AUTOMATIC_MONITORING',
    recommendation,
    proposals,
  };
}

exports.handler = async (event = {}) => {
  try {
    const configuration = await configureEasyTelegram();
    const result = await runEasyAdvisor(event, { sendMessages: true });
    return jsonResponse(200, { ok: true, version: EASY_VERSION, configuration, ...result });
  } catch (error) {
    await tgSend(`🔴 EASY MODE ERROR\n${error.message}`);
    return jsonResponse(500, { ok: false, version: EASY_VERSION, error: error.message });
  }
};

module.exports = {
  EASY_VERSION,
  easyCommands,
  buildRecommendations,
  recommendationText,
  applyRecommendations,
  runEasyAdvisor,
  configureEasyTelegram,
};