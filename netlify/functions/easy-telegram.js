const crypto = require('crypto');
const advancedTelegram = require('./telegram-advanced');
const { handler: advancedTelegramHandler } = advancedTelegram;
const { runOnboarding } = require('./portfolio-onboarding');
const { runSectorRotation } = require('./sector-rotation');
const {
  EASY_VERSION,
  applyRecommendations,
  runEasyAdvisor,
  configureEasyTelegram,
} = require('./easy-advisor');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function response(statusCode, data) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(data) };
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function getHeader(headers, name) {
  const target = String(name).toLowerCase();
  const match = Object.entries(headers || {}).find(([key]) => String(key).toLowerCase() === target);
  return match ? match[1] : '';
}

function identity(update) {
  return {
    chatId: String(update?.callback_query?.message?.chat?.id || update?.message?.chat?.id || ''),
    userId: String(update?.callback_query?.from?.id || update?.message?.from?.id || ''),
  };
}

function trustedChat(update) {
  return Boolean(TG_CHAT_ID && identity(update).chatId === TG_CHAT_ID);
}

function dynamicApproverAuthorized(update) {
  const ids = identity(update);
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '');
  const userId = String(process.env.TELEGRAM_APPROVER_USER_ID || '');
  return Boolean(chatId && userId && ids.chatId === chatId && ids.userId === userId);
}

function tgPost(method, data) {
  if (!TG_TOKEN) return Promise.resolve({ ok: false, description: 'TELEGRAM_TOKEN missing' });
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(async (res) => {
    try { return await res.json(); }
    catch { return { ok: false, description: `HTTP ${res.status}` }; }
  }).catch((error) => ({ ok: false, description: error.message }));
}

async function tgSend(text, keyboard = null) {
  const body = {
    chat_id: TG_CHAT_ID,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  return tgPost('sendMessage', body);
}

async function answerCallback(callbackId, text, showAlert = false) {
  return tgPost('answerCallbackQuery', {
    callback_query_id: callbackId,
    text: String(text).slice(0, 180),
    show_alert: showAlert,
  });
}

function normalizeCommand(text) {
  return String(text || '').trim().split(/\s+/)[0].toLowerCase().split('@')[0];
}

function easyMenuText() {
  return [
    '✨ EASY MODE',
    '',
    'บอทจะทำงานแบบนี้:',
    '1. วิเคราะห์พอร์ต ราคา กราฟ และข้อมูลที่ตรวจยืนยันได้',
    '2. ตรวจ Sector Rotation เพื่อดูว่ากลุ่มไหนกำลังนำ/อ่อนแรง',
    '3. คัดเฉพาะรายการที่ผ่านกฎและวงเงินความเสี่ยง',
    '4. โอ๊ดกดเพียง “ยืนยัน” หรือ “ไม่ทำ”',
    '',
    'คำสั่งหลัก:',
    '/easy — เริ่มหรือดูสถานะโหมดง่าย',
    '/rotation — ดู Sector Rotation สหรัฐฯ เทียบ SPY',
    '/portfolio — ดูพอร์ตล่าสุด',
    '/pending — ดูคำแนะนำที่รอยืนยัน',
    '/readiness — ดูจุดที่ระบบยังติด',
    '/advanced — เปิดเมนูคำสั่งแบบละเอียด',
    '',
    '⚠️ Sector Rotation เป็น Relative Strength/Momentum ไม่ใช่ Fund Flow หรือ Fair Value',
    '🔒 บอทไม่มีสิทธิ์ส่งออเดอร์โดยไม่มีการกดยืนยัน',
  ].join('\n');
}

async function handleEasyCallback(update, event) {
  const callback = update.callback_query;
  const data = String(callback?.data || '');

  if (data === 'EASY:APPLY') {
    await answerCallback(callback.id, 'กำลังใช้แผนที่บอทแนะนำ...');
    const result = await applyRecommendations(event, `telegram:${identity(update).userId || 'owner'}`);
    await tgSend([
      result.complete ? '✅ ตั้งค่า EASY MODE สำเร็จ' : '⚠️ ตั้งค่าได้บางส่วน',
      `ยืนยันหมวดแล้ว: ${result.applied.length} ตัว`,
      `ไม่สำเร็จ: ${result.failed.length} ตัว`,
      '',
      'จากนี้ไม่ต้องพิมพ์คำสั่งซื้อขายเอง',
      'บอทจะวิเคราะห์ตามรอบตลาด และส่งเฉพาะรายการพร้อมปุ่มยืนยันมาให้ค่ะ',
      'การจัดหมวดอาจใช้เวลาซิงก์ไม่เกินประมาณ 1 นาที',
    ].join('\n'));
    return true;
  }

  if (data === 'EASY:DETAIL') {
    await answerCallback(callback.id, 'กำลังเปิดโหมดจัดหมวดแบบละเอียด...');
    await runOnboarding(event, { sendMessages: true });
    return true;
  }

  return false;
}

function requireAdmin(event) {
  return Boolean(ADMIN_TOKEN && safeEqual(getHeader(event.headers, 'x-admin-token'), ADMIN_TOKEN));
}

exports.handler = async (event = {}) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  const action = event.queryStringParameters?.action || '';

  if (action === 'health') {
    return response(200, {
      ok: true,
      version: EASY_VERSION,
      mode: 'easy-approval',
      blobInitialization: 'lazy',
      liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true',
    });
  }

  if (action === 'configure') {
    if (event.httpMethod !== 'POST' || !requireAdmin(event)) return response(401, { error: 'Unauthorized' });
    const result = await configureEasyTelegram();
    return response(result.ok ? 200 : 502, result);
  }

  if (event.httpMethod !== 'POST') return response(405, { error: 'Method Not Allowed' });
  if (!WEBHOOK_SECRET) return response(503, { error: 'Telegram webhook disabled: secret missing' });
  if (!safeEqual(getHeader(event.headers, 'x-telegram-bot-api-secret-token'), WEBHOOK_SECRET)) {
    return response(401, { error: 'Invalid Telegram webhook secret' });
  }

  let update = {};
  try { update = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'Invalid JSON update' }); }

  if (!trustedChat(update)) {
    if (update.callback_query?.id) await answerCallback(update.callback_query.id, 'Chat นี้ไม่มีสิทธิ์ใช้งาน', true);
    return response(403, { error: 'Telegram chat is not authorized' });
  }

  if (update.callback_query && await handleEasyCallback(update, event)) {
    return response(200, { ok: true, version: EASY_VERSION });
  }

  if (update.message?.text) {
    const command = normalizeCommand(update.message.text);
    if (command === '/easy' || command === '/start') {
      await tgSend(easyMenuText());
      const result = await runEasyAdvisor(event, { sendMessages: true });
      return response(200, { ok: true, version: EASY_VERSION, stage: result.stage });
    }
    if (command === '/rotation') {
      await tgSend('⏳ กำลังคำนวณ Sector Rotation ของ 11 Sector ETFs เทียบ SPY...');
      const snapshot = await runSectorRotation(event, { sendTelegram: true, forceRefresh: true });
      return response(200, { ok: true, version: EASY_VERSION, rotationAsOf: snapshot.asOf });
    }
    if (command === '/advanced') {
      const delegated = {
        ...event,
        body: JSON.stringify({
          ...update,
          message: { ...update.message, text: '/menu' },
        }),
      };
      return advancedTelegramHandler(delegated);
    }
  }

  return advancedTelegramHandler(event);
};

module.exports._test = {
  ...(advancedTelegram._test || {}),
  EASY_VERSION,
  isAuthorizedApprover: dynamicApproverAuthorized,
  safeEqual,
  getHeader,
  identity,
  trustedChat,
  normalizeCommand,
  easyMenuText,
};