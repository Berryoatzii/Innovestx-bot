// Secure Telegram operator and approval bot.
// Read-only/operator workflows trust the configured private chat.
// Money-moving approval requires both the configured chat and approver user ID.

const crypto = require('crypto');
const { listIntents } = require('../lib/order-intent-store');
const {
  approvalAvailability,
  executeApprovedIntent,
  rejectIntent,
} = require('../lib/approval-executor');
const {
  setClassification,
  classificationMap,
  summarizeClassifications,
} = require('../lib/portfolio-classification-store');
const { fetchBrokerPortfolio } = require('../lib/broker-portfolio');
const { runOnboarding } = require('./portfolio-onboarding');
const { buildBotReadiness, readinessText } = require('../lib/bot-readiness');
const { runResearchBacktests } = require('./research-backtest');
const { runStrategyShadow } = require('./strategy-shadow');
const { runCoreReview } = require('./core-review');

const APP_VERSION = '8.5.0-action-plan';
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

function deploymentInfo() {
  return {
    version: APP_VERSION,
    commit: process.env.COMMIT_REF || process.env.VERCEL_GIT_COMMIT_SHA || 'unknown',
    branch: process.env.BRANCH || process.env.VERCEL_GIT_COMMIT_REF || 'unknown',
    platform: process.env.NETLIFY ? 'netlify' : process.env.VERCEL ? 'vercel' : 'unknown',
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true',
  };
}

function updateIdentity(update) {
  const callback = update?.callback_query;
  const message = update?.message;
  return {
    chatId: String(callback?.message?.chat?.id || message?.chat?.id || ''),
    userId: String(callback?.from?.id || message?.from?.id || ''),
    chatType: String(callback?.message?.chat?.type || message?.chat?.type || ''),
  };
}

function isTrustedOperatorChat(update) {
  const identity = updateIdentity(update);
  return Boolean(TG_CHAT_ID && identity.chatId === TG_CHAT_ID);
}

function isAuthorizedApprover(update) {
  const identity = updateIdentity(update);
  return Boolean(
    TG_CHAT_ID && APPROVER_USER_ID &&
    identity.chatId === TG_CHAT_ID &&
    identity.userId === APPROVER_USER_ID
  );
}

function tgPost(method, data) {
  if (!TG_TOKEN) return Promise.resolve({ ok: false, description: 'TELEGRAM_TOKEN missing' });
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(async (res) => {
    let payload = {};
    try { payload = await res.json(); }
    catch { payload = { ok: false, description: `HTTP ${res.status}` }; }
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

async function handleClassificationCallback(callback, event) {
  const match = /^CLS:(C|A|R):([A-Z0-9._-]{1,20})$/i.exec(String(callback.data || ''));
  if (!match) return false;
  const bucketMap = { C: 'CORE', A: 'ACTIVE', R: 'REVIEW' };
  const bucket = bucketMap[match[1].toUpperCase()];
  const symbol = match[2].toUpperCase();
  const actor = actorFromCallback(callback);

  try {
    const saved = await setClassification(symbol, bucket, {
      event,
      actor,
      note: 'Confirmed through Telegram operator console',
    });
    await answerCallback(callback.id, `บันทึก ${symbol} เป็น ${bucket} แล้ว`);
    await tgSend([
      `✅ CLASSIFIED ${saved.symbol}`,
      `หมวด: ${saved.bucket}`,
      saved.bucket === 'CORE'
        ? 'ขั้นถัดไป: ต้องมี Fundamental Snapshot + Thesis Card ก่อนซื้อเพิ่มหรือขายจากพื้นฐาน'
        : saved.bucket === 'ACTIVE'
          ? 'ขั้นถัดไป: ระบบจะทำ Backtest, Shadow และ Decision Plan ตามกฎ'
          : 'สถานะ: ยังไม่อนุญาตให้สร้างข้อเสนอซื้อขาย',
    ].join('\n'));
    await runOnboarding(event, { sendMessages: true, batchSize: 1 });
  } catch (error) {
    await answerCallback(callback.id, error.message, true);
  }
  return true;
}

async function handleApprovalCallback(callback, update, event) {
  const match = /^(APV|REJ):([a-f0-9]{16})$/i.exec(String(callback.data || ''));
  if (!match) return false;

  if (!isAuthorizedApprover(update)) {
    const identity = updateIdentity(update);
    await answerCallback(callback.id, 'User ID ผู้อนุมัติยังไม่ตรง ระบบไม่ส่งออเดอร์', true);
    await tgSend([
      '🔒 ORDER APPROVAL BLOCKED',
      `Telegram User ID ที่กด: ${identity.userId || '-'}`,
      `Approver configured: ${APPROVER_USER_ID ? 'มี แต่ไม่ตรง' : 'ยังไม่ได้ตั้ง'}`,
      'คำสั่งอ่านข้อมูลและจัดหมวดยังใช้ได้ตามปกติ แต่เงินจริงยังถูกล็อก',
    ].join('\n'));
    return true;
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
    return true;
  }

  await answerCallback(callback.id, 'รับคำขออนุมัติ กำลังตรวจราคา พอร์ต และความเสี่ยงซ้ำ...');
  try {
    const result = await executeApprovedIntent(intentId, actor, event);
    if (result.status === 'LIVE_LOCKED') {
      await tgSend([
        `🔒 APPROVAL RECEIVED [${intentId}]`,
        'ระบบรับทราบการกดอนุมัติ แต่ยังไม่ได้ส่งออเดอร์',
        'เหตุผล: Live Pilot ยังล็อกหรือวงเงินความเสี่ยงยังไม่ครบ',
      ].join('\n'));
      return true;
    }
    if (!result.executed) {
      await tgSend([
        `🛑 ORDER BLOCKED [${intentId}]`,
        `สถานะ: ${result.status}`,
        `เหตุผล: ${result.error || 'ไม่ผ่าน Risk/Execution Gate'}`,
        'ไม่มีการส่งคำสั่งซ้ำอัตโนมัติ',
      ].join('\n'));
      return true;
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
  return true;
}

async function sendPortfolioSummary(event) {
  const broker = await fetchBrokerPortfolio(event);
  const map = await classificationMap(event);
  const summary = summarizeClassifications(broker.portfolio, map);
  const rows = summary.rows.map((item) => {
    const position = broker.portfolio.find((row) => String(row.sym || row.symbol).toUpperCase() === item.symbol) || {};
    const value = Number(position.qty || 0) * Number(position.mkt || 0);
    return `${item.bucket === 'CORE' ? '🏛' : item.bucket === 'ACTIVE' ? '⚡' : '📝'} ${item.symbol} — ${item.bucket} — ${value.toLocaleString('th-TH', { maximumFractionDigits: 0 })}บ.`;
  });
  await tgSend([
    '💼 PORTFOLIO MAP',
    `CORE ${summary.counts.CORE} | ACTIVE ${summary.counts.ACTIVE} | REVIEW ${summary.counts.REVIEW}`,
    `ยังไม่ยืนยัน ${summary.counts.UNCLASSIFIED} ตัว`,
    `เงินสดจากบัญชี: ${Number(broker.cash || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท`,
    '',
    ...rows.slice(0, 30),
  ].join('\n'));
}

async function handleCommand(message, update, event) {
  const text = String(message.text || '').trim();
  const command = text.split(/\s+/)[0].toLowerCase();
  const identity = updateIdentity(update);

  if (command === '/version') {
    const info = deploymentInfo();
    await tgSend([
      '🧪 BOT VERSION',
      `Version: ${info.version}`,
      `Commit: ${String(info.commit).slice(0, 12)}`,
      `Branch: ${info.branch}`,
      `Platform: ${info.platform}`,
      `Operator chat: ${isTrustedOperatorChat(update) ? 'READY' : 'BLOCKED'}`,
      `Order approver: ${isAuthorizedApprover(update) ? 'READY' : 'LOCKED'}`,
      `Live trading: ${info.liveTradingEnabled ? 'ON' : 'OFF'}`,
    ].join('\n'));
    return;
  }

  if (command === '/whoami') {
    await tgSend([
      '👤 TELEGRAM OPERATOR ID',
      `Chat ID: ${identity.chatId || '-'}`,
      `User ID: ${identity.userId || '-'}`,
      `Chat type: ${identity.chatType || '-'}`,
      `Operator access: ${isTrustedOperatorChat(update) ? 'READY' : 'BLOCKED'}`,
      `Order approval: ${isAuthorizedApprover(update) ? 'READY' : 'LOCKED'}`,
      'ไม่มี Secret หรือ Broker Credential ถูกแสดงในข้อความนี้',
    ].join('\n'));
    return;
  }

  if (command === '/setup') {
    await tgSend(`⏳ SETUP ACK — ${APP_VERSION}\nรับคำสั่งแล้ว กำลังอ่านพอร์ตและเตรียมปุ่มจัดหมวด...`);
    await runOnboarding(event, { sendMessages: true });
    return;
  }

  if (command === '/portfolio') {
    await sendPortfolioSummary(event);
    return;
  }

  if (command === '/readiness' || command === '/status') {
    const readiness = await buildBotReadiness(event);
    await tgSend(readinessText(readiness));
    return;
  }

  if (command === '/backtest') {
    await tgSend('⏳ กำลังรัน Backtest สำหรับหุ้น ACTIVE หลังหักต้นทุน...');
    await runResearchBacktests(event, { sendTelegram: true });
    return;
  }

  if (command === '/shadow') {
    await tgSend('⏳ กำลังอัปเดตพอร์ตเงาด้วย Rules-only Engine...');
    const result = await runStrategyShadow(event, { sendTelegram: true, force: true });
    if (result.skipped) await tgSend(`⏭ Shadow ข้ามรอบ: ${result.reason}`);
    return;
  }

  if (command === '/core') {
    await tgSend('⏳ กำลังตรวจ CORE Fundamental + Thesis...');
    await runCoreReview(event, { sendTelegram: true });
    return;
  }

  if (command === '/pending') {
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
    '🤖 Investment Bot — Operator Console',
    '/version — ตรวจเวอร์ชันและสถานะสิทธิ์',
    '/whoami — ตรวจ Telegram Chat/User ID',
    '/setup — จัดหมวดหุ้น CORE / ACTIVE / REVIEW',
    '/portfolio — ดูแผนที่พอร์ต',
    '/readiness — ดูว่าระบบติดตรงไหน',
    '/backtest — ทดสอบกฎ ACTIVE หลังต้นทุน',
    '/shadow — อัปเดตพอร์ตเงา',
    '/core — ตรวจพื้นฐานและ Thesis ของ CORE',
    '/pending — ดูข้อเสนอที่รออนุมัติ',
    '',
    'Decision Plan จะแสดงจำนวน ราคา มูลค่าธุรกิจ และจังหวะกราฟ แต่ยังไม่ใช่ออเดอร์',
  ].join('\n'));
}

function requireAdmin(event) {
  if (!ADMIN_TOKEN) return false;
  return safeEqual(getHeader(event.headers, 'x-admin-token'), ADMIN_TOKEN);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  const action = event.queryStringParameters?.action || '';

  if (action === 'health') {
    return response(200, { ok: true, ...deploymentInfo(), blobInitialization: 'lazy' });
  }

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
    const result = await tgSend(`✅ Telegram Operator Bot เชื่อมต่อสำเร็จ — ${APP_VERSION}`);
    return response(result.ok ? 200 : 502, result);
  }

  if (event.httpMethod !== 'POST') return response(405, { error: 'Method Not Allowed' });
  if (!WEBHOOK_SECRET) return response(503, { error: 'Telegram webhook disabled: secret missing' });
  const suppliedSecret = getHeader(event.headers, 'x-telegram-bot-api-secret-token');
  if (!safeEqual(suppliedSecret, WEBHOOK_SECRET)) return response(401, { error: 'Invalid Telegram webhook secret' });

  let update = {};
  try { update = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'Invalid JSON update' }); }

  if (!isTrustedOperatorChat(update)) {
    if (update.callback_query?.id) await answerCallback(update.callback_query.id, 'Chat นี้ไม่มีสิทธิ์ใช้งาน', true);
    return response(403, { error: 'Telegram chat is not authorized' });
  }

  if (update.callback_query) {
    if (await handleClassificationCallback(update.callback_query, event)) return response(200, { ok: true });
    if (await handleApprovalCallback(update.callback_query, update, event)) return response(200, { ok: true });
    await answerCallback(update.callback_query.id, 'คำสั่งไม่ถูกต้อง', true);
    return response(400, { error: 'Unknown callback' });
  }

  if (update.message?.text) {
    try {
      console.log('[telegram]', APP_VERSION, update.message.text, updateIdentity(update));
      await handleCommand(update.message, update, event);
      return response(200, { ok: true, version: APP_VERSION });
    } catch (error) {
      await tgSend(`🔴 COMMAND ERROR — ${APP_VERSION}\n${error.message}`);
      return response(500, { error: error.message, version: APP_VERSION });
    }
  }

  return response(200, { ok: true, ignored: true, version: APP_VERSION });
};

module.exports._test = {
  APP_VERSION,
  deploymentInfo,
  updateIdentity,
  isTrustedOperatorChat,
  isAuthorizedApprover,
  safeEqual,
  getHeader,
  handleClassificationCallback,
};