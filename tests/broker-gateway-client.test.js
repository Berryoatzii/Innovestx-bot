const test = require('node:test');
const assert = require('node:assert/strict');

function freshClient() {
  const path = '../netlify/lib/broker-gateway-client';
  try { delete require.cache[require.resolve(path)]; } catch {}
  return require(path);
}

function cleanEnv() {
  for (const name of [
    'BROKER_GATEWAY_URL',
    'BROKER_GATEWAY_TOKEN',
    'BROKER_GATEWAY_ENVIRONMENT',
    'BROKER_GATEWAY_TIMEOUT_MS',
    'BROKER_PRODUCTION_CONFIRMATION',
    'NETLIFY',
    'AWS_LAMBDA_FUNCTION_NAME',
  ]) delete process.env[name];
}

test.afterEach(() => {
  cleanEnv();
  delete global.fetch;
});

test('gateway is disabled unless URL, token and expected environment are configured', () => {
  cleanEnv();
  assert.equal(freshClient().gatewayConfigured(), false);
  process.env.BROKER_GATEWAY_URL = 'https://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'long-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  assert.equal(freshClient().gatewayConfigured(), true);
});

test('remote cleartext gateway URL fails closed', async () => {
  process.env.BROKER_GATEWAY_URL = 'http://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'long-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  await assert.rejects(
    freshClient().gatewayRequest('/v1/health'),
    /BROKER_GATEWAY_HTTPS_REQUIRED/,
  );
});

test('localhost cleartext is allowed for a local UAT sidecar', async () => {
  process.env.BROKER_GATEWAY_URL = 'http://127.0.0.1:8787';
  process.env.BROKER_GATEWAY_TOKEN = 'long-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  global.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8787/v1/health');
    assert.equal(options.headers.Authorization, 'Bearer long-test-token');
    return { ok: true, status: 200, json: async () => ({ ok: true, environment: 'uat', data: { ready: true } }) };
  };
  const data = await freshClient().gatewayRequest('/v1/health');
  assert.equal(data.ready, true);
});

test('Netlify cloud rejects a localhost gateway before fetch', async () => {
  process.env.BROKER_GATEWAY_URL = 'http://127.0.0.1:8787';
  process.env.BROKER_GATEWAY_TOKEN = 'long-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  process.env.NETLIFY = 'true';
  global.fetch = async () => {
    assert.fail('cloud runtime must not try to fetch its own localhost');
  };
  await assert.rejects(
    freshClient().gatewayRequest('/v1/health'),
    /LOCAL_GATEWAY_UNREACHABLE_FROM_CLOUD/,
  );
});

test('AWS Lambda rejects a localhost gateway before fetch', async () => {
  process.env.BROKER_GATEWAY_URL = 'http://localhost:8787';
  process.env.BROKER_GATEWAY_TOKEN = 'long-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'thai-stock-bot';
  global.fetch = async () => {
    assert.fail('cloud runtime must not try to fetch its own localhost');
  };
  await assert.rejects(
    freshClient().gatewayRequest('/v1/health'),
    /LOCAL_GATEWAY_UNREACHABLE_FROM_CLOUD/,
  );
});

test('environment mismatch is rejected before data is trusted', async () => {
  process.env.BROKER_GATEWAY_URL = 'https://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'long-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, environment: 'prod', data: {} }),
  });
  await assert.rejects(freshClient().gatewayRequest('/v1/health'), /BROKER_GATEWAY_ENVIRONMENT_MISMATCH/);
});

test('mutations forward idempotency but never forward a PIN', async () => {
  process.env.BROKER_GATEWAY_URL = 'https://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'long-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  global.fetch = async (_url, options) => {
    assert.equal(options.headers['X-Idempotency-Key'], 'intent-001');
    assert.equal('pin' in JSON.parse(options.body), false);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, environment: 'uat', data: { orderNo: '9001' } }),
    };
  };
  const data = await freshClient().gatewayRequest('/v1/orders', {
    method: 'POST', requestId: 'intent-001', body: { symbol: 'AOT', side: 'BUY', quantity: 100, price: 20, pin: '123456' },
  });
  assert.equal(data.orderNo, '9001');
});

test('execution-uncertain response is preserved for the caller', async () => {
  process.env.BROKER_GATEWAY_URL = 'https://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'long-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  global.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      ok: false,
      environment: 'uat',
      error: 'BROKER_PLACE_UNCERTAIN',
      executionUncertain: true,
    }),
  });
  await assert.rejects(
    freshClient().gatewayRequest('/v1/orders', { method: 'POST', requestId: 'intent-002', body: {} }),
    error => error.executionUncertain === true && error.statusCode === 409,
  );
});
