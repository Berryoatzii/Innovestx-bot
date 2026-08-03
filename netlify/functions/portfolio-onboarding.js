const https = require('https');
const { fetchBrokerPortfolio } = require('../lib/broker-portfolio');
const {
  classificationMap,
  savePortfolioSnapshot,
  summarizeClassifications,
  suggestBucket,
} = require('../lib/portfolio-classification-store');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

function tgPost(method, data) {
  if (!TG_TOKEN || !TG_CHAT_ID) return Promise.resolve({ ok: false, description: 'Telegram not configured' });
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
  const payload = {
    chat_id: TG_CHAT_ID,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  return tgPost('sendMessage', payload);
}

function bucketLabel(bucket) {
  if (bucket === 'CORE') return 'CORE — ถือยาว/ปันผล/พื้นฐาน';
  if (bucket === 'ACTIVE') return 'ACTIVE — Swing สัปดาห์ถึงเดือน';
  return 'REVIEW — ยังไม่อนุญาตให้ซื้อขาย';
}

async function runOnboarding(event = {}, options = {}) {
  const broker = await fetchBrokerPortfolio(event);
  await savePortfolioSnapshot(broker.portfolio, broker.cash, event);
  const map = await classificationMap(event);
  const summary = summarizeClassifications(broker.portfolio, map);
  const batchSize = Math.max(1, Math.min(10, Number(options.batchSize || process.env.ONBOARDING_BATCH_SIZE || 5)));
  const pending = summary.rows.filter((item) => !item.explicit).slice(0, batchSize);

  if (options.sendMessages !== false) {
    await tgSend([
      '🧭 PORTFOLIO SETUP',
      `หุ้นในพอร์ต: ${summary.rows.length} ตัว`,
      `จัดหมวดแล้ว: ${summary.rows.length - summary.counts.UNCLASSIFIED} ตัว`,
      `ยังไม่จัดหมวด: ${summary.counts.UNCLASSIFIED} ตัว`,
      '',
      'หลักการ:',
      '• CORE = ถือยาวจากพื้นฐานและ Thesis',
      '• ACTIVE = Swing ตามกฎเทคนิค',
      '• REVIEW = ยังไม่มีสิทธิ์สร้างข้อเสนอ',
    ].join('\n'));

    if (pending.length === 0) {
      await tgSend('✅ พอร์ตถูกจัดหมวดครบแล้ว ใช้ /readiness เพื่อตรวจขั้นถัดไป');
    } else {
      for (const item of pending) {
        const position = broker.portfolio.find((row) => String(row.sym || row.symbol).toUpperCase() === item.symbol) || {};
        const suggestion = suggestBucket(item.symbol);
        const qty = Number(position.qty || position.quantity || 0);
        const price = Number(position.mkt || position.marketPrice || 0);
        await tgSend([
          `📌 จัดหมวด ${item.symbol}`,
          `ถืออยู่: ${qty.toLocaleString('th-TH')} หุ้น`,
          `ราคาปัจจุบันจากพอร์ต: ${price > 0 ? price.toFixed(2) : 'ไม่พร้อม'}`,
          `คำแนะนำตั้งต้น: ${bucketLabel(suggestion.bucket)}`,
          suggestion.sourceDate
            ? `อ้างอิงหมวดจากรายชื่อเก่า ${suggestion.sourceDate} เท่านั้น ไม่ใช่คำแนะนำซื้อ`
            : 'ไม่มีคำแนะนำจากรายชื่อเดิม',
          '',
          'โอ๊ดเป็นผู้ยืนยันหมวดสุดท้ายค่ะ',
        ].join('\n'), [
          [{ text: '🏛 CORE', callback_data: `CLS:C:${item.symbol}` }],
          [{ text: '⚡ ACTIVE', callback_data: `CLS:A:${item.symbol}` }],
          [{ text: '📝 REVIEW', callback_data: `CLS:R:${item.symbol}` }],
        ]);
      }
    }
  }

  return {
    brokerPositions: broker.portfolio.length,
    cash: broker.cash,
    summary,
    pendingShown: pending.map((item) => item.symbol),
  };
}

exports.handler = async (event = {}) => {
  try {
    const result = await runOnboarding(event, { sendMessages: true });
    return jsonResponse(200, { ok: true, ...result });
  } catch (error) {
    await tgSend(`🔴 PORTFOLIO SETUP ERROR\n${error.message}`);
    return jsonResponse(500, { ok: false, error: error.message });
  }
};

module.exports.runOnboarding = runOnboarding;
