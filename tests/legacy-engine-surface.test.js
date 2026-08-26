const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const enginePath = path.join(__dirname, '..', 'netlify', 'lib', 'invx-engine.js');

test('legacy engine contains no broker credentials or mutation transport', () => {
  const source = fs.readFileSync(enginePath, 'utf8');
  assert.equal(source.includes('INVX_PIN'), false);
  assert.equal(source.includes('INVX_SECRET'), false);
  assert.equal(source.includes('settradeLogin'), false);
  assert.equal(source.includes('authPost'), false);
  assert.equal(source.includes('authPatch'), false);
  assert.equal(source.includes("action === 'order'"), false);
  assert.equal(source.includes("action === 'cancel'"), false);
});

test('legacy engine is chart-only and needs no account credentials', async () => {
  delete require.cache[require.resolve('../netlify/lib/invx-engine')];
  const { handler } = require('../netlify/lib/invx-engine');
  const unknown = await handler({
    httpMethod: 'GET', headers: {}, queryStringParameters: { action: 'getData' }, body: '',
  });
  assert.equal(unknown.statusCode, 400);
  assert.match(JSON.parse(unknown.body).error, /chart-only/i);
  const missingSymbol = await handler({
    httpMethod: 'GET', headers: {}, queryStringParameters: { action: 'chart' }, body: '',
  });
  assert.equal(missingSymbol.statusCode, 400);
  assert.match(JSON.parse(missingSymbol.body).error, /symbol/i);
});

test('advisory engine has no direct Settrade credential or order path', async () => {
  const advisoryPath = path.join(__dirname, '..', 'netlify', 'lib', 'autotrade-engine.js');
  const source = fs.readFileSync(advisoryPath, 'utf8');
  for (const forbidden of ['INVX_PIN', 'INVX_SECRET', 'settradeLogin', 'placeOrder', 'open-api.settrade.com']) {
    assert.equal(source.includes(forbidden), false, `forbidden legacy surface: ${forbidden}`);
  }
  delete require.cache[require.resolve('../netlify/lib/autotrade-engine')];
  const { runAutoTrader } = require('../netlify/lib/autotrade-engine');
  const result = await runAutoTrader('dry_run');
  assert.equal(result.orders_placed.length, 0);
  assert.match(result.summary, /portfolio input required/i);
});
