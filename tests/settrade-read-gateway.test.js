const test = require('node:test');
const assert = require('node:assert/strict');

function cleanEnv() {
  for (const name of [
    'BROKER_GATEWAY_URL',
    'BROKER_GATEWAY_TOKEN',
    'BROKER_GATEWAY_ENVIRONMENT',
    'NETLIFY',
    'AWS_LAMBDA_FUNCTION_NAME',
  ]) delete process.env[name];
}

function freshRead() {
  for (const path of ['../netlify/lib/settrade-read', '../netlify/lib/broker-gateway-client']) {
    try { delete require.cache[require.resolve(path)]; } catch {}
  }
  return require('../netlify/lib/settrade-read');
}

test.afterEach(() => {
  cleanEnv();
  delete global.fetch;
});

test('order reconciliation reads only through the official SDK gateway', async () => {
  process.env.BROKER_GATEWAY_URL = 'https://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'gateway-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://broker.example.test/v1/orders');
    assert.equal(options.method, 'GET');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        environment: 'uat',
        data: {
          environment: 'uat',
          orders: [{
            accountNo: 'MUST-NOT-LEAVE-NORMALIZER',
            orderNo: '9001', symbol: 'AOT', side: 'Buy', price: 20,
            vol: 100, matched: 20, status: 'MP', entryTime: '2026-08-05T10:00:00+07:00',
          }],
        },
      }),
    };
  };

  const orders = await freshRead().fetchRawOrders();
  assert.deepEqual(orders, [{
    id: '9001', symbol: 'AOT', side: 'BUY', price: 20, quantity: 100,
    matchedQuantity: 20, status: 'MP', entryTime: '2026-08-05T10:00:00+07:00', canCancel: false,
  }]);
  assert.equal('raw' in orders[0], false);
});

