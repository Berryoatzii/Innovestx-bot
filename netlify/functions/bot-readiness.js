const https = require('https');
const { buildBotReadiness, readinessText } = require('../lib/bot-readiness');
const { isStrongConsistencyError } = require('../lib/blob-runtime');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

let lastErrorSignature = '';
let lastErrorSentAt = 0;

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

function errorMessage(error) {
  if (isStrongConsistencyError(error)) {
    return [
      '🟠 BOT STORAGE NOTICE',
      'ระบบอ่านข้อมูลสำหรับ Setup/Research ด้วยโหมดสำรองแล้ว',
      'ส่วนการอนุมัติเงินจริงยังถูกล็อก เพราะ Runtime ยังไม่รองรับ Strong Consistency',
      'ไม่มีคำสั่งซื้อขายจริงถูกส่ง',
    ].join('\n');
  }
  return `🔴 READINESS ERROR\n${String(error?.message || error).slice(0, 1200)}`;
}

function shouldSendError(error) {
  const signature = String(error?.message || error);
  const now = Date.now();
  if (signature === lastErrorSignature && now - lastErrorSentAt < 15 * 60 * 1000) return false;
  lastErrorSignature = signature;
  lastErrorSentAt = now;
  return true;
}

exports.handler = async (event = {}) => {
  try {
    const readiness = await buildBotReadiness(event);
    await postTelegram(readinessText(readiness));
    return jsonResponse(200, { ok: true, readiness });
  } catch (error) {
    if (shouldSendError(error)) await postTelegram(errorMessage(error));
    return jsonResponse(500, {
      ok: false,
      error: error.message,
      liveTradingSafe: true,
      liveOrdersPlaced: 0,
    });
  }
};

module.exports._test = { errorMessage, shouldSendError };
