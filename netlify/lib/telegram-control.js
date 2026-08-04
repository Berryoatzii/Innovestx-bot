const https = require('https');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const PRIMARY_SITE_URL = String(
  process.env.PRIMARY_SITE_URL || 'https://investmentavengers.netlify.app'
).replace(/\/$/, '');

function tgPost(method, data = {}) {
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
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ ok: false, description: 'telegram_timeout' });
    });
    req.write(body);
    req.end();
  });
}

function expectedWebhookUrl() {
  return `${PRIMARY_SITE_URL}/.netlify/functions/telegram`;
}

function easyCommands() {
  return [
    { command: 'easy', description: 'โหมดง่าย ให้บอทแนะนำแล้วกดยืนยัน' },
    { command: 'rotation', description: 'ดู Sector Rotation สหรัฐฯ เทียบ SPY' },
    { command: 'portfolio', description: 'ดูพอร์ตและเงินสดล่าสุด' },
    { command: 'pending', description: 'ดูคำแนะนำที่รอยืนยัน' },
    { command: 'readiness', description: 'ดูความพร้อมของระบบ' },
    { command: 'advanced', description: 'เปิดเมนูขั้นสูง' },
  ];
}

async function getWebhookInfo() {
  return tgPost('getWebhookInfo', {});
}

async function configurePrimaryWebhook() {
  if (!WEBHOOK_SECRET) {
    return { ok: false, description: 'TELEGRAM_WEBHOOK_SECRET missing' };
  }
  const webhook = await tgPost('setWebhook', {
    url: expectedWebhookUrl(),
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false,
    max_connections: 5,
  });
  const menu = TG_CHAT_ID
    ? await tgPost('setMyCommands', {
        commands: easyCommands(),
        scope: { type: 'chat', chat_id: Number(TG_CHAT_ID) },
        language_code: 'th',
      })
    : { ok: false, description: 'TELEGRAM_CHAT_ID missing' };
  return {
    ok: Boolean(webhook.ok && menu.ok),
    expectedWebhookUrl: expectedWebhookUrl(),
    webhook,
    menu,
  };
}

async function diagnoseAndRepair(options = {}) {
  const before = await getWebhookInfo();
  const actualUrl = String(before?.result?.url || '');
  const expectedUrl = expectedWebhookUrl();
  const hasRecentError = Boolean(before?.result?.last_error_message);
  const needsRepair = !before.ok || actualUrl !== expectedUrl || hasRecentError;
  let repair = null;
  if (needsRepair || options.force) repair = await configurePrimaryWebhook();
  const after = repair ? await getWebhookInfo() : before;
  return {
    ok: Boolean(after?.ok && String(after?.result?.url || '') === expectedUrl),
    expectedUrl,
    actualUrl: String(after?.result?.url || ''),
    pendingUpdateCount: Number(after?.result?.pending_update_count || 0),
    lastErrorDate: after?.result?.last_error_date || null,
    lastErrorMessage: after?.result?.last_error_message || null,
    maxConnections: after?.result?.max_connections || null,
    secretConfigured: Boolean(WEBHOOK_SECRET),
    chatConfigured: Boolean(TG_CHAT_ID),
    tokenConfigured: Boolean(TG_TOKEN),
    repaired: Boolean(repair),
    repairOk: repair ? Boolean(repair.ok) : null,
  };
}

module.exports = {
  PRIMARY_SITE_URL,
  expectedWebhookUrl,
  easyCommands,
  tgPost,
  getWebhookInfo,
  configurePrimaryWebhook,
  diagnoseAndRepair,
};