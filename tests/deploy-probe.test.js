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
  assert.equal(payload.version, '8.4.2-deploy-probe');
  assert.equal(payload.blobInitialization, 'lazy');
  assert.equal(payload.liveTradingEnabled, false);
  assert.equal(_test.APP_VERSION, '8.4.2-deploy-probe');
});
