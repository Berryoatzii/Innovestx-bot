const test = require('node:test');
const assert = require('node:assert/strict');

function clearModules() {
  for (const p of [
    '../netlify/functions/autotrader-trigger',
    '../netlify/functions/autotrade',
    '../netlify/lib/autotrade-engine',
  ]) {
    try { delete require.cache[require.resolve(p)]; } catch {}
  }
}

function resetEnv() {
  delete process.env.ADMIN_TOKEN;
  delete process.env.LIVE_TRADING_ENABLED;
  delete process.env.SCHEDULED_LIVE_TRADING_ENABLED;
  delete process.env.SCHEDULED_TRADE_MODE;
  delete process.env.EXECUTE_CONFIRMATION;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.INVX_KEY;
  delete process.env.INVX_SECRET;
  delete process.env.INVX_PIN;
  delete process.env.INVX_ACCOUNT;
}

test.beforeEach(() => {
  resetEnv();
  clearModules();
});

test('safe auto-trader rejects execute when global live lock is off', async () => {
  const { runAutoTrader } = require('../netlify/functions/autotrade');
  await assert.rejects(
    () => runAutoTrader('execute', [{ sym: 'TEST', qty: 100, avg: 10, mkt: 9 }]),
    /Live trading is locked/
  );
});

test('scheduled handler defaults to dry_run', async () => {
  const { handler } = require('../netlify/functions/autotrade');
  const response = await handler({});
  const payload = JSON.parse(response.body);

  assert.equal(payload.ok, true);
  assert.equal(payload.mode, 'dry_run');
});

test('dry_run with supplied portfolio only simulates orders', async () => {
  const { runAutoTrader } = require('../netlify/functions/autotrade');
  const result = await runAutoTrader('dry_run', [
    { sym: 'TEST', qty: 100, avg: 10, mkt: 2 },
  ]);

  assert.equal(result.mode, 'dry_run');
  assert.equal(result.orders_placed.length, 1);
  assert.equal(result.orders_placed[0].orderId, 'SIMULATE');
});

test('manual trigger fails closed when ADMIN_TOKEN is missing', async () => {
  const { handler } = require('../netlify/functions/autotrader-trigger');
  const response = await handler({
    httpMethod: 'POST',
    headers: {},
    queryStringParameters: { mode: 'analyze' },
    body: '{}',
  });

  assert.equal(response.statusCode, 503);
  assert.match(response.body, /ADMIN_TOKEN/);
});

test('manual trigger rejects GET requests', async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token';
  clearModules();
  const { handler } = require('../netlify/functions/autotrader-trigger');
  const response = await handler({
    httpMethod: 'GET',
    headers: { 'x-admin-token': 'test-admin-token' },
    queryStringParameters: { mode: 'analyze' },
    body: '',
  });

  assert.equal(response.statusCode, 405);
});

test('manual execute remains locked without LIVE_TRADING_ENABLED', async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token';
  process.env.EXECUTE_CONFIRMATION = 'confirm-token';
  clearModules();
  const { handler } = require('../netlify/functions/autotrader-trigger');
  const response = await handler({
    httpMethod: 'POST',
    headers: {
      'x-admin-token': 'test-admin-token',
      'x-execute-confirmation': 'confirm-token',
    },
    queryStringParameters: { mode: 'execute' },
    body: JSON.stringify({ portfolio: [{ sym: 'TEST', qty: 100, avg: 10, mkt: 2 }] }),
  });

  assert.equal(response.statusCode, 423);
  assert.match(response.body, /Live trading is locked/);
});
