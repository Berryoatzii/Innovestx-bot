// Secure Telegram operator and approval bot.
// Read-only/operator workflows trust the configured private chat.
// Money-moving approval requires both the configured chat and approver user ID.

const crypto = require('crypto');
const { listIntents } = require('../lib/order-intent-store');
const {
  approvalAvailability,
  approveIntent,
  rejectIntent,
} = require('../lib/approval-executor');
const {
  setClassification,
  classificationMap,
  summarizeClassifications,
} = require('../lib/portfolio-classification-store');
const { fetchBrokerPortfolio } = require('../lib/broker-portfolio');
const { buildActionPlan, formatActionPlan } = require('../lib/portfolio-action-plan');
const { createManualOrderDraft, formatManualDraft } = require('../lib/manual-order-draft');
const { runOnboarding } = require('./portfolio-onboarding');
const { buildBotReadiness, readinessText } = require('../lib/bot-readiness');
const { runResearchBacktests } = require('./research-backtest');
const { runStrategyShadow } = require('./strategy-shadow');
const { runCoreReview } = require('./core-review');
const { runSafetyDrill, readSafetyDrillStatus } = require('../lib/operational-safety-drill');

const APP_VERSION = '8.7.0-safety-drill';
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

function commandDefinitions() {
  return [
    { command: 'menu', description: 'แสดงเมนูคำสั่งภาษาไทย' },
    { command: 'setup', description: 'จัดหุ้นเป็น CORE ACTIVE หรือ REVIEW' },
    { command: 'portfolio', description: 'ดูพอร์ต เงินสด และหมวดหุ้น' },
    { command: 'plan', description: 'ดูแผนราคาและจำนวน เช่น /plan ICN' },
    { command: 'buy', description: 'สร้างร่าง Limit Buy เช่น /buy AIT 100 4.90' },
    { command: 'sell', description: 'สร้างร่าง Limit Sell เช่น /sell ICN 300 2.24' },
    { command: 'pending', description: 'ดูร่างออเดอร์ที่รออนุมัติ' },
    { command: 'orders', description: 'ดูคำสั่งซื้อขายในบัญชีโบรกเกอร์' },
    { command: 'readiness', description: 'ตรวจความพร้อมและจุดที่ยังติด' },
    { command: 'backtest', description: 'ทดสอบกลยุทธ์ ACTIVE หลังต้นทุน' },
    { command: 'shadow', description: 'อัปเดตพอร์ตทดลองแบบไม่ใช้เงินจริง' },
    { command: 'core', description: 'ตรวจพื้นฐานและ Thesis หุ้น CORE' },
    { command: 'whoami', description: 'ตรวจ Chat ID และสิทธิ์อนุมัติ' },
    { command: 'safetydrill', description: 'ทดสอบอนุมัติ แจ้งเตือน และ one-order lock' },
    { command: 'version', description: 'ตรวจเวอร์ชันที่กำลัง Deploy' },
  ];
}

function menuText() {
  return [
    '📚 เมนู Berry Trading Bot',
    '',
    '1) ตั้งค่าพอร์ต',
    '/setup — กดจัดหุ้นเป็น CORE / ACTIVE / REVIEW',
    '/portfolio — ดูพอร์ตและเงินสดล่าสุด',
    '',
    '2) วิเคราะห์หุ้น',
    '/plan ICN — ดูราคาตลาด มูลค่าธุรกิจ แนวรับ–แนวต้าน และจำนวนที่เหมาะสม',
    '/core — ตรวจงบและ Thesis ของหุ้น CORE',
    '/backtest — ทดสอบกฎหุ้น ACTIVE',
    '/shadow — อัปเดตพอร์ตทดลอง',
    '',
    '3) สร้างร่างออเดอร์ Limit',
    '/buy AIT 100 4.90 — ร่างซื้อ 100 หุ้น ราคา 4.90',
    '/sell ICN 300 2.24 — ร่างขาย 300 หุ้น ราคา 2.24',
    '/pending — ดูร่างที่รอกดอนุมัติ',
    '/orders — ดูออเดอร์ที่โบรกเกอร์รับแล้ว',
    '',
    '4) ตรวจระบบ',
    '/readiness — ดูว่ายังติดตรงไหน',
    '/whoami — ตรวจสิทธิ์ Telegram',
    '/safetydrill — ทดสอบ Safety Gate โดยไม่สร้างหรือส่งออเดอร์',
    '/version — ตรวจเวอร์ชัน Bot',
    '',
    '⚠️ /buy และ /sell สร้างเพียงร่างออเดอร์ ต้องกดอนุมัติอีกครั้ง และใช้ได้เฉพาะหุ้น ACTIVE ที่จัดหมวดแล้ว',
    '🔒 การส่งเงินจริงยังขึ้นกับ Live Pilot Lock, Risk Gate และเวลาตลาด',
  ].join('\n');
}

function normalizeCommand(token) {
  return String(token || '').toLowerCase().split('@')[0];
}

function parseManualCommand(text, side) {
  const parts = String(text || '').trim().split(/\s+/);
  if (parts.length !== 4) {
    const example = side === 'BUY' ? '/buy AIT 100 4.90' : '/sell ICN 300 2.24';
    throw new Error(`รูปแบบไม่ถูกต้อง ตัวอย่าง: ${example}`);
  }
  return {
    side,
    symbol: parts[1],
    quantity: Number(parts[2]),
    price: Number(parts[3]),
  };
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

async function configureCommandMenu() {
  if (!TG_CHAT_ID) return { ok: false, description: 'TELEGRAM_CHAT_ID missing' };
  return tgPost('setMyCommands', {
    commands: commandDefinitions(),
    scope: { type: 'chat', chat_id: Number(TG_CHAT_ID) },
    language_code: 'th',
  });
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

function approvalKeyboard(intent) {
  return [
    [{ text: `✅ ตรวจและอนุมัติ ${intent.symbol}`, callback_data: `APV:${intent.id}` }],
    [{ text: `❌ ปฏิเสธ ${intent.symbol}`, callback_data: `REJ:${intent.id}` }],
  ];
}

function safetyDrillKeyboard() {
  return [[{ text: '🛡 ยืนยัน Safety Drill (ไม่ใช่ออเดอร์)', callback_data: 'SDR:CONFIRM' }]];
}

async function handleSafetyDrillCallback(callback, update, event) {
  if (String(callback.data || '') !== 'SDR:CONFIRM') return false;
  if (!isAuthorizedApprover(update)) {
    await answerCallback(callback.id, 'ผู้กดไม่ใช่ Approver ที่ตั้งไว้ ไม่มีการทำรายการ', true);
    return true;
  }
  await answerCallback(callback.id, 'กำลังทดสอบ Safety Gate โดยไม่เรียกโบรกเกอร์...');
  try {
    const evidence = await runSafetyDrill(event, () => tgSend([
      '🛡 AEGIS SAFETY ALERT TEST',
      'Human approval callback: PASS',
      'One-order lock: PASS (ครั้งที่สองถูกปฏิเสธ)',
      'Broker call: NONE',
      'Order intent: NONE',
      'Money moving: NO',
    ].join('\n')));
    await tgSend(`✅ Safety Drill ผ่าน ${new Date(evidence.testedAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`);
  } catch (error) {
    await tgSend(`🔴 Safety Drill ไม่ผ่าน: ${String(error.message || 'UNKNOWN').slice(0, 120)}\nไม่มีการเรียกโบรกเกอร์`);
  }
  return true;
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
      `✅ จัดหมวด ${saved.symbol} เป็น ${saved.bucket} แล้ว`,
      saved.bucket === 'CORE'
        ? `ใช้ /plan ${saved.symbol} เพื่อดูแผน และ /core เพื่อตรวจพื้นฐานก่อนตัดสินใจ`
        : saved.bucket === 'ACTIVE'
          ? `ใช้ /plan ${saved.symbol} หรือสร้างร่างด้วย /buy และ /sell`
          : 'หุ้น REVIEW ยังสร้างร่างออเดอร์ไม่ได้',
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
      '🔒 อนุมัติออเดอร์ไม่ได้',
      `Telegram User ID ที่กด: ${identity.userId || '-'}`,
      `Approver configured: ${APPROVER_USER_ID ? 'มี แต่ไม่ตรง' : 'ยังไม่ได้ตั้ง'}`,
      'คำสั่งอ่านข้อมูลและสร้างร่างยังใช้ได้ แต่เงินจริงยังถูกล็อก',
    ].join('\n'));
    return true;
  }

  const [, action, intentId] = match;
  const actor = actorFromCallback(callback);
  if (action.toUpperCase() === 'REJ') {
    try {
      const rejected = await rejectIntent(intentId, actor, event);
      await answerCallback(callback.id, 'ปฏิเสธร่างออเดอร์แล้ว');
      await tgSend([
        `❌ ปฏิเสธแล้ว [${rejected.id}]`,
        `${rejected.side} ${rejected.symbol} ${rejected.quantity} หุ้น @ ${Number(rejected.proposedPrice).toFixed(2)}`,
        'ไม่มีการส่งคำสั่งไปยังโบรกเกอร์',
      ].join('\n'));
    } catch (error) {
      await answerCallback(callback.id, error.message, true);
    }
    return true;
  }

  await answerCallback(callback.id, 'รับคำขออนุมัติ กำลังตรวจราคา พอร์ต และความเสี่ยงซ้ำ...');
  try {
    const result = await approveIntent(intentId, actor, event);
    if (result.status === 'LIVE_LOCKED') {
      await tgSend([
        `🔒 รับการอนุมัติแล้ว [${intentId}]`,
        'ยังไม่ได้ส่งออเดอร์ เพราะ Live Pilot หรือวงเงินความเสี่ยงยังล็อกอยู่',
        'ร่างออเดอร์จะไม่ถูกส่งย้อนหลังอัตโนมัติ',
      ].join('\n'));
      return true;
    }
    if (!result.executed) {
      if (result.queued) {
        await tgSend([
          `✅ อนุมัติและเข้าคิวแล้ว [${intentId}]`,
          `${result.intent.side} ${result.intent.symbol} ${result.intent.quantity} หุ้น`,
          `ราคา Limit: ${Number(result.intent.proposedPrice).toFixed(2)}`,
          'Private Worker จะตรวจราคา เงินสด พอร์ต ออเดอร์ซ้ำ และความเสี่ยงอีกครั้งก่อนส่ง',
          'สถานะนี้ยังไม่ใช่หลักฐานว่าโบรกเกอร์รับออเดอร์แล้ว',
        ].join('\n'));
        return true;
      }
      await tgSend([
        `🛑 ออเดอร์ถูกบล็อก [${intentId}]`,
        `สถานะ: ${result.status}`,
        `เหตุผล: ${result.error || 'ไม่ผ่าน Risk/Execution Gate'}`,
        'ไม่มีการส่งคำสั่งซ้ำอัตโนมัติ',
      ].join('\n'));
      return true;
    }
    const intent = result.intent;
    await tgSend([
      `✅ ส่งออเดอร์แล้ว [${intent.id}]`,
      `${intent.side} ${intent.symbol} ${intent.quantity} หุ้น`,
      `ราคา Limit: ${Number(intent.broker?.submittedPrice || 0).toFixed(2)}`,
      `Order ID: ${intent.broker?.orderId || 'รอตรวจสอบ'}`,
      `สถานะ: ${result.status}`,
      result.status === 'RECONCILE_PENDING'
        ? '⚠️ ห้ามกดส่งซ้ำ ระบบกำลังรอตรวจสถานะกับโบรกเกอร์'
        : 'ระบบบันทึกผลและตรวจสถานะกับโบรกเกอร์แล้ว',
    ].join('\n'));
  } catch (error) {
    await tgSend([
      `🔴 เกิดข้อผิดพลาดตอนอนุมัติ [${intentId}]`,
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
    '💼 พอร์ตปัจจุบัน',
    `CORE ${summary.counts.CORE} | ACTIVE ${summary.counts.ACTIVE} | REVIEW ${summary.counts.REVIEW}`,
    `ยังไม่ยืนยัน ${summary.counts.UNCLASSIFIED} ตัว`,
    `เงินสด: ${Number(broker.cash || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท`,
    '',
    ...rows.slice(0, 30),
  ].join('\n'));
}

async function sendStockPlan(symbol, event) {
  const normalized = String(symbol || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,20}$/.test(normalized)) throw new Error('ตัวอย่างที่ถูกต้อง: /plan ICN');
  const broker = await fetchBrokerPortfolio(event);
  const position = broker.portfolio.find((item) => String(item.sym || '').toUpperCase() === normalized);
  if (!position) throw new Error(`ไม่พบ ${normalized} ในพอร์ต`);
  const plan = await buildActionPlan({
    symbol: normalized,
    sym: normalized,
    side: 'REVIEW',
    qty: Number(position.qty || 0),
    avg: Number(position.avg || 0),
    mkt: Number(position.mkt || 0),
    reason: 'ผู้ใช้เรียกดู Decision Plan รายตัว',
  }, event);
  await tgSend(formatActionPlan(plan));
}

async function createAndSendManualDraft(text, side, identity, event) {
  const parsed = parseManualCommand(text, side);
  const result = await createManualOrderDraft(parsed, event, {
    actor: `telegram:${identity.userId || 'operator'}`,
  });
  await tgSend(formatManualDraft(result), approvalKeyboard(result.intent));
}

async function sendPending(event) {
  const pending = await listIntents(event, { status: 'PENDING_APPROVAL', limit: 20 });
  if (pending.length === 0) {
    await tgSend('✅ ไม่มีร่างออเดอร์ที่รออนุมัติ');
    return;
  }
  await tgSend(`⏳ มีร่างออเดอร์รออนุมัติ ${pending.length} รายการ`);
  for (const item of pending.slice(0, 10)) {
    await tgSend([
      `📝 ร่าง [${item.id}]`,
      `${item.side} ${item.symbol} ${item.quantity} หุ้น @ ${Number(item.proposedPrice).toFixed(2)}`,
      `แบบ: ${item.orderStyle || 'MARKETABLE_LIMIT'} | หมดอายุ ${new Date(item.expiresAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`,
    ].join('\n'), approvalKeyboard(item));
  }
}

async function sendBrokerOrders(event) {
  const broker = await fetchBrokerPortfolio(event);
  const orders = Array.isArray(broker.orders) ? broker.orders : [];
  if (orders.length === 0) {
    await tgSend('✅ ตอนนี้ไม่พบออเดอร์ในบัญชีโบรกเกอร์');
    return;
  }
  const rows = orders.slice(0, 20).map((item) => {
    const symbol = item.symbol || item.sym || '-';
    const side = item.side || '-';
    const qty = item.quantity || item.qty || item.volume || 0;
    const price = item.price || item.orderPrice || 0;
    const status = item.status || item.orderStatus || '-';
    return `• ${side} ${symbol} ${qty} หุ้น @ ${Number(price || 0).toFixed(2)} — ${status}`;
  });
  await tgSend(['📋 ออเดอร์ในบัญชีโบรกเกอร์', ...rows].join('\n'));
}

async function handleCommand(message, update, event) {
  const text = String(message.text || '').trim();
  const parts = text.split(/\s+/);
  const command = normalizeCommand(parts[0]);
  const identity = updateIdentity(update);

  if (command === '/start' || command === '/menu' || command === '/help') {
    await configureCommandMenu();
    await tgSend(menuText());
    return;
  }

  if (command === '/version') {
    const info = deploymentInfo();
    await tgSend([
      '🧪 เวอร์ชันระบบ',
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
      '👤 ข้อมูล Telegram Operator',
      `Chat ID: ${identity.chatId || '-'}`,
      `User ID: ${identity.userId || '-'}`,
      `Chat type: ${identity.chatType || '-'}`,
      `ใช้คำสั่งทั่วไป: ${isTrustedOperatorChat(update) ? 'READY' : 'BLOCKED'}`,
      `อนุมัติเงินจริง: ${isAuthorizedApprover(update) ? 'READY' : 'LOCKED'}`,
      'ไม่มี Secret หรือ Broker Credential ถูกแสดงในข้อความนี้',
    ].join('\n'));
    return;
  }

  if (command === '/safetydrill') {
    if (!isAuthorizedApprover(update)) {
      await tgSend('🔒 Safety Drill ต้องเรียกจาก Chat และ User ID ของ Approver ที่ตั้งไว้');
      return;
    }
    await tgSend([
      '🛡 Safety Drill — ไม่มีการซื้อขาย',
      'การกดปุ่มจะทดสอบตัวตน Approver, การส่ง Alert และ one-order lock เท่านั้น',
      'ระบบจะไม่สร้าง Order Intent และไม่เรียก Broker Gateway',
    ].join('\n'), safetyDrillKeyboard());
    return;
  }

  if (command === '/setup') {
    await tgSend(`⏳ รับคำสั่งแล้ว — ${APP_VERSION}\nกำลังอ่านพอร์ตและเตรียมปุ่มจัดหมวด...`);
    await runOnboarding(event, { sendMessages: true });
    return;
  }

  if (command === '/portfolio') {
    await sendPortfolioSummary(event);
    return;
  }

  if (command === '/plan') {
    await sendStockPlan(parts[1], event);
    return;
  }

  if (command === '/buy') {
    await createAndSendManualDraft(text, 'BUY', identity, event);
    return;
  }

  if (command === '/sell') {
    await createAndSendManualDraft(text, 'SELL', identity, event);
    return;
  }

  if (command === '/pending') {
    await sendPending(event);
    return;
  }

  if (command === '/orders') {
    await sendBrokerOrders(event);
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

  await tgSend(['ไม่รู้จักคำสั่งนี้ค่ะ', '', menuText()].join('\n'));
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

  if (action === 'safetyDrillStatus') {
    try {
      return response(200, await readSafetyDrillStatus(event));
    } catch {
      return response(200, { passed: false, safeDefault: true });
    }
  }

  if (action === 'setWebhook') {
    if (event.httpMethod !== 'POST' || !requireAdmin(event)) return response(401, { error: 'Unauthorized' });
    if (!WEBHOOK_SECRET) return response(503, { error: 'TELEGRAM_WEBHOOK_SECRET missing' });
    const host = getHeader(event.headers, 'x-forwarded-host') || getHeader(event.headers, 'host');
    if (!host) return response(400, { error: 'Host header missing' });
    const webhookUrl = `https://${host}/.netlify/functions/telegram`;
    const webhook = await tgPost('setWebhook', {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
      max_connections: 5,
    });
    const menu = webhook.ok ? await configureCommandMenu() : { ok: false, description: 'webhook_failed' };
    return response(webhook.ok && menu.ok ? 200 : 502, { webhook, menu });
  }

  if (action === 'configureMenu') {
    if (event.httpMethod !== 'POST' || !requireAdmin(event)) return response(401, { error: 'Unauthorized' });
    const result = await configureCommandMenu();
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
    if (await handleSafetyDrillCallback(update.callback_query, update, event)) return response(200, { ok: true });
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
      await tgSend(`🔴 คำสั่งทำงานไม่สำเร็จ — ${APP_VERSION}\n${error.message}`);
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
  commandDefinitions,
  menuText,
  normalizeCommand,
  parseManualCommand,
  safeEqual,
  getHeader,
  handleClassificationCallback,
  handleSafetyDrillCallback,
  safetyDrillKeyboard,
};
