const https = require('https');
const corePolicy = require('../../config/core-fundamental-policy.json');
const { loadPortfolioPolicy } = require('../lib/portfolio-policy');
const { getSnapshot, snapshotFreshness } = require('../lib/fundamental-snapshot-store');
const { getThesisCard, isThesisApproved } = require('../lib/core-thesis-store');
const { evaluateFundamentals, detectThesisBreak } = require('../lib/fundamental-scorecard');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function response(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

function postTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return Promise.resolve({ sent: false });
  const body = JSON.stringify({
    chat_id: TG_CHAT_ID,
    text: String(text).slice(0, 4096),
    disable_web_page_preview: true,
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ sent: res.statusCode >= 200 && res.statusCode < 300 }));
    });
    req.on('error', (error) => resolve({ sent: false, error: error.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ sent: false, error: 'telegram_timeout' }); });
    req.write(body);
    req.end();
  });
}

function summarizeRow(row) {
  const icon = row.overall === 'PASS' ? '🟢' : row.overall === 'REVIEW' ? '🟡' : '🔴';
  const reasons = row.reasons.length > 0 ? row.reasons.slice(0, 4).join(', ') : 'ผ่านทุก Gate';
  return `${icon} ${row.symbol}: ${row.overall} — ${reasons}`;
}

exports.handler = async (event = {}) => {
  const portfolioPolicy = loadPortfolioPolicy();
  const coreSymbols = portfolioPolicy.classification.coreSymbols || [];
  const rows = [];

  for (const symbol of coreSymbols) {
    const snapshot = await getSnapshot(symbol, event);
    const thesis = await getThesisCard(symbol, event);
    const freshness = snapshotFreshness(snapshot, corePolicy);
    const thesisApproval = isThesisApproved(thesis);
    const fundamentals = snapshot ? evaluateFundamentals(snapshot, { policy: corePolicy }) : null;
    const thesisBreak = snapshot ? detectThesisBreak(snapshot, snapshot.previousSnapshot || null, { policy: corePolicy }) : { broken: false, reasons: [] };

    const reasons = [];
    if (!freshness.fresh) reasons.push(freshness.reason);
    if (!thesisApproval.approved) reasons.push(thesisApproval.reason);
    if (fundamentals && !fundamentals.passed) reasons.push(...fundamentals.hardFailures);
    if (thesisBreak.broken) reasons.push(...thesisBreak.reasons);

    let overall = 'PASS';
    if (!snapshot || !thesis || thesisBreak.broken || (fundamentals && fundamentals.status === 'FAIL')) overall = 'FAIL';
    else if (reasons.length > 0 || fundamentals?.status === 'REVIEW') overall = 'REVIEW';

    rows.push({
      symbol,
      overall,
      reasons: [...new Set(reasons)],
      freshness,
      thesisApproval,
      fundamentals,
      thesisBreak,
      permittedAction: overall === 'PASS' ? 'HOLD_OR_REVIEW_BUY_ZONE' : 'NO_TRADE',
    });
  }

  const lines = [
    '🏛 CORE QUALITY–DIVIDEND–VALUE REVIEW',
    `เวลา: ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`,
    `CORE ที่กำหนด: ${coreSymbols.length} ตัว`,
    '🔒 รายงานนี้ไม่สร้าง Order Intent และไม่ถัวอัตโนมัติ',
    '',
  ];

  if (rows.length === 0) {
    lines.push('• ยังไม่มีหุ้นที่ได้รับการจัดเป็น CORE ทุกตัวจึงยังอยู่ REVIEW');
  } else {
    lines.push(...rows.map(summarizeRow));
  }
  await postTelegram(lines.join('\n'));

  return response(200, {
    ok: true,
    strategyVersion: corePolicy.strategyVersion,
    rows,
    liveOrdersPlaced: 0,
    orderIntentsCreated: 0,
  });
};
