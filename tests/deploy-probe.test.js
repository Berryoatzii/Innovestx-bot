const test = require('node:test');
const assert = require('node:assert/strict');

function clear(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; } catch {}
}

test('Telegram health probe responds without Blobs or broker access', async () => {
  delete process.env.TELEGRAM_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_APPROVER_USER_ID;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.LIVE_TRADING_ENABLED;

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
  assert.equal(payload.ok, true);
  assert.equal(payload.version, 'EASY_APPROVAL_V1.1.0');
  assert.equal(payload.mode, 'easy-approval');
  assert.equal(payload.blobInitialization, 'lazy');
  assert.equal(payload.liveTradingEnabled, false);
  assert.equal(_test.EASY_VERSION, 'EASY_APPROVAL_V1.1.0');
});