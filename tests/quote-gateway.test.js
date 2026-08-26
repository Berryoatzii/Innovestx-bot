const test = require('node:test');
const assert = require('node:assert/strict');

function clean() {
  for (const name of [
    'BROKER_GATEWAY_URL', 'BROKER_GATEWAY_TOKEN', 'BROKER_GATEWAY_ENVIRONMENT',
    'ADMIN_TOKEN', 'NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME',
  ]) delete process.env[name];
  delete global.fetch;
  for (const path of [
    '../netlify/functions/invx', '../netlify/lib/broker-gateway-client', '../netlify/lib/invx-engine',
  ]) {
    try { delete require.cache[require.resolve(path)]; } catch {}
  }
}

test.beforeEach(clean);
test.afterEach(clean);

test('public market quote is read through the SDK gateway without account credentials in Node', async () => {
  process.env.BROKER_GATEWAY_URL = 'https://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'gateway-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://broker.example.test/v1/quotes/AOT');
    assert.equal(options.method, 'GET');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true, environment: 'uat',
        data: { environment: 'uat', quote: { symbol: 'AOT', last: 20.1, bid: 20, ask: 20.2, volume: 250000 } },
      }),
    };
  };

  const { handler } = require('../netlify/functions/invx');
  const response = await handler({
    httpMethod: 'GET', headers: {}, queryStringParameters: { action: 'quote', sym: 'AOT' }, body: '',
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { symbol: 'AOT', last: 20.1, bid: 20, ask: 20.2, volume: 250000 });
});

test('invalid quote symbol is rejected before calling the gateway', async () => {
  process.env.BROKER_GATEWAY_URL = 'https://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'gateway-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  global.fetch = async () => assert.fail('invalid symbol must not reach the gateway');
  const { handler } = require('../netlify/functions/invx');
  const response = await handler({
    httpMethod: 'GET', headers: {}, queryStringParameters: { action: 'quote', sym: '../AOT' }, body: '',
  });
  assert.equal(response.statusCode, 400);
});

