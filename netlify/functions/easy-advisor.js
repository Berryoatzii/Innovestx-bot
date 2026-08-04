const { fetchBrokerPortfolio } = require('../lib/broker-portfolio');
const {
  classificationMap,
  summarizeClassifications,
  suggestBucket,
  setClassification,
  savePortfolioSnapshot,
} = require('../lib/portfolio-classification-store');
const {
  easyCommands,
  configurePrimaryWebhook,
  diagnoseAndRepair,
  tgPost,
} = require('../lib/telegram-control');

const TG_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const EASY_VERSION = 'EASY_APPROVAL_V1.2.0';

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
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

async function configureEasyTelegram() {
  return configurePrimaryWebhook();
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
    'หลังยืนยัน บอทจะส่งเฉพาะรายการที่ผ่านกฎมาให้กด “ยืนยัน” หรือ “ไม่ทำ”',
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
    };
  }

  if (sendMessages) {
    await tgSend([
      '✅ EASY MODE กำลังทำงาน',
      'พอร์ตจัดหมวดครบแล้ว และบอทเฝ้าตลาดให้อัตโนมัติ',
      '',
      'รอบ Sector Rotation: 08:35 น.',
      'รอบคำแนะนำซื้อขาย: 10:15 และ 14:15 น.',
      'ถ้าไม่มีรายการผ่านกฎ บอทจะไม่ฝืนสร้างออเดอร์',
    ].join('\n'));
  }
  return {
    stage: 'AUTOMATIC_MONITORING',
    recommendation,
  };
}

exports.handler = async (event = {}) => {
  try {
    const configuration = await diagnoseAndRepair({ force: true });
    const result = await runEasyAdvisor(event, { sendMessages: true });
    return jsonResponse(200, {
      ok: true,
      version: EASY_VERSION,
      configuration,
      ...result,
    });
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