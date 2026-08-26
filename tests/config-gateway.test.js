const test = require('node:test');
const assert = require('node:assert/strict');

test('public config reports gateway readiness without legacy broker secrets', async () => {
  process.env.BROKER_GATEWAY_URL = 'https://broker.example.test';
  process.env.BROKER_GATEWAY_TOKEN = 'gateway-test-token';
  process.env.BROKER_GATEWAY_ENVIRONMENT = 'uat';
  process.env.ALLOWED_ORIGIN = 'https://dashboard.example.test';
  delete require.cache[require.resolve('../netlify/functions/config')];
  const { handler } = require('../netlify/functions/config');
  const response = await handler({ httpMethod: 'GET' });
  const body = JSON.parse(response.body);
  assert.equal(body.brokerGatewayReady, true);
  assert.equal(body.brokerGatewayEnvironment, 'uat');
  assert.equal(Object.hasOwn(body, 'invxReady'), false);
  assert.equal(response.headers['Access-Control-Allow-Origin'], 'https://dashboard.example.test');
});
