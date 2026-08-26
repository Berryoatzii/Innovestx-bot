const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function clearModules() {
  for (const p of [
    '../netlify/functions/autotrader-trigger',
    '../netlify/functions/autotrade',
    '../netlify/functions/invx',
    '../netlify/functions/telegram',
    '../netlify/lib/autotrade-engine',
    '../netlify/lib/invx-engine',
    '../netlify/lib/broker-gateway-client',
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
    'BROKER_GATEWAY_URL',
    'BROKER_GATEWAY_TOKEN',
    'BROKER_GATEWAY_ENVIRONMENT',
    'BROKER_PRODUCTION_CONFIRMATION',
  ]) delete process.env[name];
  delete global.fetch;
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

test('legacy engine also rejects direct execute attempts', async () => {
  const { runAutoTrader } = require('../netlify/lib/autotrade-engine');
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

test('signed intent cannot be disabled by an environment flag', async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token';
  process.env.EXECUTE_CONFIRMATION = 'confirm-token';
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.HUMAN_APPROVAL_ONLY = 'false';
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
    body: JSON.stringify({ ticker: 'AOT', side: 'Buy', quantity: 100, price: 40 }),
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

for (const action of ['getData', 'ping', 'debug']) {
  test(`private broker read ${action} is unavailable without ADMIN_TOKEN`, async () => {
    const { handler } = require('../netlify/functions/invx');
    const response = await handler({
      httpMethod: 'GET',
      headers: {},
      queryStringParameters: { action },
      body: '',
    });

    assert.equal(response.statusCode, 503);
    assert.match(response.body, /ADMIN_TOKEN/);
  });

  test(`private broker read ${action} rejects an invalid ADMIN_TOKEN`, async () => {
    process.env.ADMIN_TOKEN = 'private-read-token';
    clearModules();
    const { handler } = require('../netlify/functions/invx');
    const response = await handler({
      httpMethod: 'GET',
      headers: { 'x-admin-token': 'wrong-token' },
      queryStringParameters: { action },
      body: '',
    });

    assert.equal(response.statusCode, 401);
    assert.match(response.body, /Unauthorized/);
  });
}

test('private portfolio read fails closed instead of using the legacy broker REST path', async () => {
  process.env.ADMIN_TOKEN = 'private-read-token';
  clearModules();
  const { handler } = require('../netlify/functions/invx');
  const response = await handler({
    httpMethod: 'GET',
    headers: { 'x-admin-token': 'private-read-token' },
    queryStringParameters: { action: 'getData' },
    body: '',
  });

  assert.equal(response.statusCode, 503);
  assert.match(response.body, /BROKER_GATEWAY_NOT_CONFIGURED/);
});

test('private portfolio read is normalized from the official SDK gateway', async () => {
  process.env.ADMIN_TOKEN = 'private-read-token';
  process.env.BROKER_GATEWAY_URL = 'http://127.0.0.1:8787';
  process.env.BROKER_GATEWAY_TOKEN = 'gateway-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      environment: 'uat',
      data: {
        environment: 'uat',
        portfolio: [{ sym: 'AOT', qty: 100, avg: 18, mkt: 20 }],
        orders: [],
        cash: 5000,
        cashVerified: true,
      },
    }),
  });
  clearModules();
  const { handler } = require('../netlify/functions/invx');
  const response = await handler({
    httpMethod: 'GET',
    headers: { 'x-admin-token': 'private-read-token' },
    queryStringParameters: { action: 'getData' },
    body: '',
  });
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.portfolio[0].sym, 'AOT');
  assert.equal(payload.cash, 5000);
  assert.equal(payload.cashVerified, true);
});

test('cancel remains locked when live trading is off', async () => {
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
    queryStringParameters: { action: 'cancel', id: '123' },
    body: '{}',
  });

  assert.equal(response.statusCode, 423);
  assert.match(response.body, /Live trading is locked/);
});

test('public dashboard does not embed a real portfolio snapshot', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /let PORTFOLIO = \[\{"sym":/);
  assert.doesNotMatch(html, /const AI_TAGS=\{PM:/);
  assert.doesNotMatch(html, /id=["']ctPinF["']/);
  assert.doesNotMatch(html, /id=["']orderPinInp["']/);
  assert.doesNotMatch(html, /\/api\/invx\?action=order/);
  assert.match(html, /Direct chart execution is permanently disabled/);
  assert.match(html, /function escapeHtml\(value\)/);
  assert.match(html, /escapeHtml\(msg\)/);
});
