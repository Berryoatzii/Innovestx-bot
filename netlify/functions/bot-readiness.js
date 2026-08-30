const https = require('https');
const crypto = require('crypto');
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

function getHeader(headers = {}, name) {
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function safeEqual(left, right) {
  const aa = Buffer.from(String(left || ''));
  const bb = Buffer.from(String(right || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function isScheduledInvocation(event = {}) {
  return Boolean(
    event.next_run
    || event.nextRun
    || event.triggerSource === 'schedule'
    || getHeader(event.headers, 'x-netlify-event').toLowerCase() === 'schedule'
  );
}

function isDetailedReadAuthorized(event = {}) {
  const expected = process.env.ADMIN_TOKEN || '';
  return Boolean(expected && safeEqual(getHeader(event.headers, 'x-admin-token'), expected));
}

function publicReadiness(readiness = {}) {
  const shadow = readiness.shadowGate || {};
  const drForwardShadow = readiness.drForwardShadow || {};
  const activeResearch = readiness.activeResearch || {};
  const coreEvidence = readiness.coreEvidence || {};
  const releaseEvidence = readiness.releaseEvidence || {};
  return {
    generatedAt: readiness.generatedAt || null,
    stages: readiness.stages || {},
    telegramReady: Boolean(readiness.telegramReady),
    classificationComplete: Boolean(readiness.classification?.complete),
    coreEvidence: {
      passed: Number(coreEvidence.passed || 0),
      total: Number(coreEvidence.total || 0),
    },
    activeResearch: {
      passed: Number(activeResearch.passed || 0),
      total: Number(activeResearch.total || 0),
    },
    shadowGate: {
      passed: Boolean(shadow.passed),
      tradingDays: Number(shadow.tradingDays || 0),
      decisionEvents: Number(shadow.decisionEvents || 0),
      tradeEvents: Number(shadow.tradeEvents || 0),
      benchmarkCoverage: Number(shadow.benchmarkCoverage || 0),
      shadowReturn: Number(shadow.shadowReturn || 0),
      benchmarkReturn: Number(shadow.benchmarkReturn || 0),
      excessReturn: Number(shadow.excessReturn || 0),
      worstDrawdown: Number(shadow.worstDrawdown || 0),
      checks: shadow.checks || {},
    },
    drForwardShadow: {
      passed: Boolean(drForwardShadow.passed),
      tradingDays: Number(drForwardShadow.tradingDays || 0),
      instrumentDecisionEvents: Number(drForwardShadow.instrumentDecisionEvents || 0),
      rebalanceEvents: Number(drForwardShadow.rebalanceEvents || 0),
      dataErrors: Number(drForwardShadow.dataErrors || 0),
    },
    approvalReady: Boolean(readiness.approval?.ready),
    releaseEvidence: {
      passed: Boolean(releaseEvidence.passed),
      blockers: Array.isArray(releaseEvidence.blockers) ? releaseEvidence.blockers : [],
    },
    liveTradingEnabled: false,
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
  const scheduled = isScheduledInvocation(event);
  try {
    const readiness = await buildBotReadiness(event);
    if (scheduled) await postTelegram(readinessText(readiness));
    const detailed = scheduled || isDetailedReadAuthorized(event);
    return jsonResponse(200, { ok: true, readiness: detailed ? readiness : publicReadiness(readiness) });
  } catch (error) {
    if (scheduled && shouldSendError(error)) await postTelegram(errorMessage(error));
    return jsonResponse(500, {
      ok: false,
      error: scheduled || isDetailedReadAuthorized(event) ? error.message : 'READINESS_UNAVAILABLE',
      liveTradingSafe: true,
      liveOrdersPlaced: 0,
    });
  }
};

module.exports._test = {
  errorMessage,
  shouldSendError,
  getHeader,
  safeEqual,
  isScheduledInvocation,
  isDetailedReadAuthorized,
  publicReadiness,
};
