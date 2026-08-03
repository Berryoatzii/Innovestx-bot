const https = require('https');
const { buildBotReadiness, readinessText } = require('../lib/bot-readiness');

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
  if (!TG_TOKEN || !TG_CHAT_ID) return Promise.resolve({ sent: false });
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: String(text).slice(0, 4096) });
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
    req.setTimeout(8000, () => { req.destroy(); resolve({ sent: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

exports.handler = async (event = {}) => {
  try {
    const readiness = await buildBotReadiness(event);
    await postTelegram(readinessText(readiness));
    return jsonResponse(200, { ok: true, readiness });
  } catch (error) {
    await postTelegram(`🔴 READINESS ERROR\n${error.message}`);
    return jsonResponse(500, { ok: false, error: error.message });
  }
};
