const https = require('https');
const { buildSectorRotation, formatSectorRotation } = require('../lib/sector-rotation');
const { saveSectorRotation, getLatestSectorRotation } = require('../lib/sector-rotation-store');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

function postTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return Promise.resolve({ sent: false, reason: 'TELEGRAM_NOT_CONFIGURED' });
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
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ sent: res.statusCode >= 200 && res.statusCode < 300 }));
    });
    req.on('error', (error) => resolve({ sent: false, error: error.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ sent: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function runSectorRotation(event = {}, options = {}) {
  const forceRefresh = options.forceRefresh !== false;
  let snapshot = null;
  if (!forceRefresh) snapshot = await getLatestSectorRotation(event).catch(() => null);
  if (!snapshot) {
    snapshot = await buildSectorRotation({ range: '5y', timeoutMs: 15000 });
    await saveSectorRotation(snapshot, event);
  }
  if (options.sendTelegram !== false) await postTelegram(formatSectorRotation(snapshot));
  return snapshot;
}

exports.handler = async (event = {}) => {
  try {
    const snapshot = await runSectorRotation(event, { sendTelegram: true, forceRefresh: true });
    return jsonResponse(200, { ok: true, ...snapshot });
  } catch (error) {
    await postTelegram(`🔴 SECTOR ROTATION ERROR\n${error.message}\nไม่มีออเดอร์ถูกสร้าง`);
    return jsonResponse(500, { ok: false, error: error.message });
  }
};

module.exports.runSectorRotation = runSectorRotation;
module.exports._test = { jsonResponse };