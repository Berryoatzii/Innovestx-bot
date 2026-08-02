const test = require('node:test');
const assert = require('node:assert/strict');

function clearModules() {
  for (const p of [
    '../netlify/functions/autotrader-trigger',
    '../netlify/functions/autotrade',
    '../netlify/functions/invx',
    '../netlify/functions/telegram',
    '../netlify/lib/autotrade-engine',
    '../netlify/lib/invx-engine',
    '../netlify/lib/order-intent-store',
    '../netlify/lib/approval-executor',
  ]) {
    try { delete require.cache[require.resolve(p)]; } catch {}
  }
}

function resetEnv() {
  for (const name of [
    'ADMIN_TOKEN',
    'LIVE_TRADING_ENABLED',
    'HUMAN_APPROVAL_LIVE_ENABLED',
    'HUMAN_APPROVAL_ONLY',
    'SCHEDULED_LIVE_TRADING_ENABLED',
    'SCHEDULED_TRADE_MODE',
    'EXECUTE_CONFIRMATION',
    'ORDER_INTENT_GATE_SECRET',
    'GROQ_API_KEY',
    'GEMINI_API_KEY',
    'INVX_KEY',
    'INVX_SECRET',
    'INVX_PIN',
    'INVX_ACCOUNT',
    'ALLOWED_ORIGIN',
    'TELEGRAM_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_APPROVER_USER_ID',
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_PROGRESS_ENABLED',
    'MAX_LIVE_ORDER_VALUE',
    'MAX_DAILY_APPROVED_NOTIONAL',
  ]) delete process.env[name];
}

test.beforeEach(() => {
  resetEnv();
  clearModules();
});

test('auto-trader rejects every direct execute attempt', async () => {
  const { runAutoTrader } = require('../netlify/functions/autotrade');
  await assert.rejects(
    () => runAutoTrader('execute', [{ sym: 'TEST', qty: 500, avg: 10, mkt: 9 }]),
    /DIRECT_EXECUTE_DISABLED_USE_HUMAN_APPROVAL/
  );
});

test('scheduled mode normalizes execute to dry_run', () => {
  const { _test } = require('../netlify/functions/autotrade');
  assert.equal(_test.normalizeMode('execute'), 'dry_run');
  assert.equal(_test.normalizeMode('dry_run'), 'dry_run');
});

test('dry_run with supplied portfolio only simulates orders', async () => {
  const { runAutoTrader } = require('../netlify/functions/autotrade');
  const result = await runAutoTrader('dry_run', [
    { sym: 'TEST', qty: 500, avg: 10, mkt: 2 },
  ]);

  assert.equal(result.mode, 'dry_run');
  assert.equal(result.orders_placed.length, 1);
  assert.equal(result.orders_placed[0].orderId, 'SIMULATE');
});

test('shadow summary contains simulated signals only', () => {
  const { _test } = require('../netlify/functions/autotrade');
  const summary = _test.summarizeSignals({
    orders_placed: [
      { orderId: 'SIMULATE', side: 'Sell', sym: 'TEST', qty: 500, mkt: 10 },
    ],
    orders_failed: [],
  });

  assert.equal(summary.simulated.length, 1);
  assert.equal(summary.failedCount, 0);
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

test('manual execute is disabled even when live flags exist', async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token';
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.EXECUTE_CONFIRMATION = 'confirm-token';
  clearModules();
  const { handler } = require('../netlify/functions/autotrader-trigger');
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'x-admin-token': 'test-admin-token' },
    queryStringParameters: { mode: 'execute' },
    body: '{}',
  });

  assert.equal(response.statusCode, 405);
  assert.match(response.body, /Direct execute is disabled/);
});

test('direct order endpoint is disabled when ADMIN_TOKEN is missing', async () => {
  const { handler } = require('../netlify/functions/invx');
  const response = await handler({
    httpMethod: 'POST',
    headers: {},
    queryStringParameters: { action: 'order' },
    body: JSON.stringify({ ticker: 'TEST', side: 'Sell', quantity: 100, price: 10 }),
  });

  assert.equal(response.statusCode, 503);
  assert.match(response.body, /ADMIN_TOKEN/);
});

test('direct order endpoint remains locked when live trading is off', async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token';
  process.env.EXECUTE_CONFIRMATION = 'confirm-token';
  clearModules();
  const { handler } = require('../netlify/functions/invx');
  const response = await handler({
    httpMethod: 'POST',
    headers: {
      'x-admin-token': 'test-admin-token',
      'x-execute-confirmation': 'confirm-token',
    },
    queryStringParameters: { action: 'order' },
    body: JSON.stringify({ ticker: 'TEST', side: 'Sell', quantity: 100, price: 10 }),
  });

  assert.equal(response.statusCode, 423);
  assert.match(response.body, /Live trading is locked/);
});

test('live order is rejected without a signed intent', async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token';
  process.env.EXECUTE_CONFIRMATION = 'confirm-token';
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.ORDER_INTENT_GATE_SECRET = 'intent-gate-secret';
  clearModules();
  const { handler } = require('../netlify/functions/invx');
  const response = await handler({
    httpMethod: 'POST',
    headers: {
      'x-admin-token': 'test-admin-token',
      'x-execute-confirmation': 'confirm-token',
    },
    queryStringParameters: { action: 'order' },
    body: JSON.stringify({ ticker: 'TEST', side: 'Sell', quantity: 100, price: 10 }),
  });

  assert.equal(response.statusCode, 401);
  assert.match(response.body, /order intent ID/i);
});

test('cancel endpoint rejects GET before reaching broker', async () => {
  const { handler } = require('../netlify/functions/invx');
  const response = await handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { action: 'cancel', id: '123' },
    body: '',
  });

  assert.equal(response.statusCode, 405);
});
