// Secure Telegram approval bot.
// No AI analysis, demo portfolio, or direct broker API calls live here.

const crypto = require('crypto');
const {
  initializeBlobContext,
  listIntents,
} = require('../lib/order-intent-store');
const {
  approvalAvailability,
  executeApprovedIntent,
  rejectIntent,
} = require('../lib/approval-executor');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const APPROVER_USER_ID = String(process.env.TELEGRAM_APPROVER_USER_ID || '');
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

function tgPost(method, data) {
  if (!TG_TOKEN) return Promise.resolve({ ok: false, description: 'TELEGRAM_TOKEN missing' });
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(async (res) => {
    let payload = {};
    try { payload = await res.json(); } catch { payload = { ok: false, description: `HTTP ${res.status}` }; }
    return payload;
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

function actorFromCallback(callback) {
  return `telegram:${callback.from?.id || 'unknown'}`;
}

function isAuthorizedTelegramUpdate(update) {
  const callback = update.callback_query;
  const message = update.message;
  const chatId = String(callback?.message?.chat?.id || message?.chat?.id || '');
  const userId = String(callback?.from?.id || message?.from?.id || '');
  return Boolean(TG_CHAT_ID && APPROVER_USER_ID && chatId === TG_CHAT_ID && userId === APPROVER_USER_ID);
}

async function handleApprovalCallback(callback, event) {
  const match = /^(APV|REJ):([a-f0-9]{16})$/i.exec(String(callback.data || ''));
  if (!match) {
    await answerCallback(callback.id, 'คำสั่งไม่ถูกต้อง', true);
    return;
  }

  const [, action, intentId] = match;
  const actor = actorFromCallback(callback);

  if (action.toUpperCase() === 'REJ') {
    try {
      const rejected = await rejectIntent(intentId, actor, event);
      await answerCallback(callback.id, 'ปฏิเสธข้อเสนอแล้ว');
      await tgSend([
        `❌ REJECTED [${rejected.id}]`,
        `${rejected.side} ${rejected.symbol} ${rejected.quantity} หุ้น`,
        'ไม่มีการส่งคำสั่งไปยังโบรกเกอร์',
      ].join('\n'));
    } catch (error) {
      await answerCallback(callback.id, error.message, true);
    }
    return;
  }

  await answerCallback(callback.id, 'รับคำขออนุมัติ กำลังตรวจซ้ำ...');

  try {
    const result = await executeApprovedIntent(intentId, actor, event);
    if (result.status === 'LIVE_LOCKED') {
      await tgSend([
        `🔒 APPROVAL RECEIVED [${intentId}]`,
        'ระบบรับทราบการกดอนุมัติ แต่ยังไม่ได้ส่งออเดอร์',
        'เหตุผล: Live Pilot ยังล็อกหรือวงเงินความเสี่ยงยังไม่ครบ',
        'Intent ยังคงรออนุมัติและจะหมดอายุตามเวลาที่กำหนด',
      ].join('\n'));
      return;
    }

    if (!result.executed) {
      await tgSend([
        `🛑 ORDER BLOCKED [${intentId}]`,
        `สถานะ: ${result.status}`,
        `เหตุผล: ${result.error || 'ไม่ผ่าน Risk/Execution Gate'}`,
        'ไม่มีการส่งคำสั่งซ้ำอัตโนมัติ',
      ].join('\n'));
      return;
    }

    const intent = result.intent;
    await tgSend([
      `✅ ORDER SUBMITTED [${intent.id}]`,
      `${intent.side} ${intent.symbol} ${intent.quantity} หุ้น`,
      `ราคา Limit: ${Number(intent.broker?.submittedPrice || 0).toFixed(2)}`,
      `Order ID: ${intent.broker?.orderId || 'รอตรวจสอบ'}`,
      `สถานะ: ${result.status}`,
      result.status === 'RECONCILE_PENDING'
        ? '⚠️ ห้ามกดส่งซ้ำ ระบบกำลังรอ Reconcile กับโบรกเกอร์'
        : 'ระบบบันทึกผลและตรวจสถานะกับโบรกเกอร์แล้ว',
    ].join('\n'));
  } catch (error) {
    await tgSend([
      `🔴 APPROVAL ERROR [${intentId}]`,
      `สาเหตุ: ${error.message}`,
      'ไม่มีการส่งคำสั่งซ้ำอัตโนมัติ',
    ].join('\n'));
  }
}

async function handleCommand(message, event) {
  const text = String(message.text || '').trim().toLowerCase();

  if (text === '/status') {
    const availability = approvalAvailability();
    const pending = await listIntents(event, { status: 'PENDING_APPROVAL', limit: 100 });
    await tgSend([
      '📊 BOT STATUS',
      `Pending approvals: ${pending.length}`,
      `Live trading: ${availability.liveTradingEnabled ? 'ON' : 'OFF'}`,
      `Human approval execution: ${availability.humanApprovalEnabled ? 'ON' : 'OFF'}`,
      `Risk limits configured: ${availability.maxOrderValue > 0 && availability.maxDailyNotional > 0 ? 'YES' : 'NO'}`,
      `Approval engine ready: ${availability.ready ? 'YES' : 'NO'}`,
    ].join('\n'));
    return;
  }

  if (text === '/pending') {
    const pending = await listIntents(event, { status: 'PENDING_APPROVAL', limit: 20 });
    if (pending.length === 0) {
      await tgSend('✅ ไม่มี Order Intent ที่รออนุมัติ');
      return;
    }
    const rows = pending.slice(0, 10).map((item) =>
      `• ${item.id} ${item.side} ${item.symbol} ${item.quantity}หุ้น @${Number(item.proposedPrice).toFixed(2)} หมดอายุ ${item.expiresAt}`
    );
    await tgSend(['⏳ PENDING ORDER INTENTS', ...rows].join('\n'));
    return;
  }

  await tgSend([
    '🤖 Investment Bot — Human Approval Mode',
    '/status — ดูสถานะ Safety/Approval',
    '/pending — ดูข้อเสนอที่รออนุมัติ',
    'การซื้อขายจริงเกิดได้เฉพาะจากปุ่มอนุมัติของ Intent ที่ยังไม่หมดอายุ',
  ].join('\n'));
}

function requireAdmin(event) {
  if (!ADMIN_TOKEN) return false;
  return safeEqual(getHeader(event.headers, 'x-admin-token'), ADMIN_TOKEN);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  await initializeBlobContext(event);

  const action = event.queryStringParameters?.action || '';

  if (action === 'setWebhook') {
    if (event.httpMethod !== 'POST' || !requireAdmin(event)) return response(401, { error: 'Unauthorized' });
    if (!WEBHOOK_SECRET) return response(503, { error: 'TELEGRAM_WEBHOOK_SECRET missing' });
    const host = getHeader(event.headers, 'x-forwarded-host') || getHeader(event.headers, 'host');
    if (!host) return response(400, { error: 'Host header missing' });
    const webhookUrl = `https://${host}/.netlify/functions/telegram`;
    const result = await tgPost('setWebhook', {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      max_connections: 5,
    });
    return response(result.ok ? 200 : 502, result);
  }

  if (action === 'test') {
    if (event.httpMethod !== 'POST' || !requireAdmin(event)) return response(401, { error: 'Unauthorized' });
    const result = await tgSend('✅ Telegram Human Approval Bot เชื่อมต่อสำเร็จ');
    return response(result.ok ? 200 : 502, result);
  }

  if (event.httpMethod !== 'POST') return response(405, { error: 'Method Not Allowed' });
  if (!WEBHOOK_SECRET) return response(503, { error: 'Telegram webhook disabled: secret missing' });
  const suppliedSecret = getHeader(event.headers, 'x-telegram-bot-api-secret-token');
  if (!safeEqual(suppliedSecret, WEBHOOK_SECRET)) return response(401, { error: 'Invalid Telegram webhook secret' });

  let update = {};
  try { update = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'Invalid JSON update' }); }

  if (!isAuthorizedTelegramUpdate(update)) {
    if (update.callback_query?.id) await answerCallback(update.callback_query.id, 'ไม่มีสิทธิ์อนุมัติ', true);
    return response(403, { error: 'Telegram user/chat is not authorized' });
  }

  if (update.callback_query) {
    await handleApprovalCallback(update.callback_query, event);
    return response(200, { ok: true });
  }

  if (update.message?.text) {
    await handleCommand(update.message, event);
    return response(200, { ok: true });
  }

  return response(200, { ok: true, ignored: true });
};

module.exports._test = { safeEqual, getHeader, isAuthorizedTelegramUpdate };
