const test = require('node:test');
const assert = require('node:assert/strict');

function clear(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; } catch {}
}

test('Easy Mode recommends only unclassified positions and preserves explicit choices', () => {
  const { buildRecommendations } = require('../netlify/functions/easy-advisor');
  const portfolio = [
    { sym: 'ICN', qty: 1500, mkt: 2.16 },
    { sym: 'UNKNOWN', qty: 100, mkt: 10 },
  ];
  const map = {
    ICN: { symbol: 'ICN', bucket: 'ACTIVE', explicit: true },
  };
  const result = buildRecommendations(portfolio, map);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].symbol, 'UNKNOWN');
  assert.equal(result.pending[0].bucket, 'REVIEW');
  assert.equal(result.summary.rows.find((item) => item.symbol === 'ICN').bucket, 'ACTIVE');
});

test('Easy command menu hides manual buy and sell from the primary workflow', () => {
  const { easyCommands } = require('../netlify/functions/easy-advisor');
  const commands = easyCommands().map((item) => item.command);
  assert.deepEqual(commands, ['easy', 'portfolio', 'pending', 'readiness', 'advanced']);
  assert.equal(commands.includes('buy'), false);
  assert.equal(commands.includes('sell'), false);
});

test('Easy recommendation explains one-click confirmation and no direct execution', () => {
  const { recommendationText } = require('../netlify/functions/easy-advisor');
  const text = recommendationText({
    summary: { rows: [{ symbol: 'ICN' }] },
    pending: [{ symbol: 'ICN', bucket: 'CORE' }],
    counts: { CORE: 1, ACTIVE: 0, REVIEW: 0 },
  });
  assert.match(text, /ตั้งค่าครั้งเดียว/);
  assert.match(text, /ไม่ใช่คำสั่งซื้อขาย/);
  assert.match(text, /ยืนยัน/);
});

test('Primary Telegram webhook health reports Easy Approval mode', async () => {
  clear('../netlify/functions/telegram');
  clear('../netlify/functions/easy-telegram');
  const { handler, _test } = require('../netlify/functions/telegram');
  const result = await handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { action: 'health' },
    body: '',
  });
  assert.equal(result.statusCode, 200);
  const payload = JSON.parse(result.body);
  assert.equal(payload.mode, 'easy-approval');
  assert.equal(payload.version, 'EASY_APPROVAL_V1.0.0');
  assert.equal(_test.EASY_VERSION, 'EASY_APPROVAL_V1.0.0');
});

test('Easy router delegates non-easy commands and recognizes bot suffixes', () => {
  clear('../netlify/functions/easy-telegram');
  const { _test } = require('../netlify/functions/easy-telegram');
  assert.equal(_test.normalizeCommand('/easy@BerryTradingBot'), '/easy');
  assert.match(_test.easyMenuText(), /ยืนยัน/);
  assert.match(_test.easyMenuText(), /ไม่มีสิทธิ์ส่งออเดอร์/);
});