const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyDeployment } = require('../tools/verify-rc2-deployment');

const COMMIT = 'a'.repeat(40);

function response(status, payload) {
  return { status, async json() { return payload; } };
}

function mockFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('api.netlify.com')) {
      return response(200, { published_deploy: {
        commit_ref: COMMIT,
        branch: 'claude/ai-agent-deployment-game-vpLlI',
        state: 'ready',
        published_at: '2026-08-31T01:00:00Z',
      } });
    }
    if (url.includes('telegram-advanced')) {
      return response(200, { ok: true, version: '9.0.0-rc2-forward-shadow',
        liveTradingEnabled: overrides.liveTradingEnabled ?? false });
    }
    return response(overrides.shadowStatus ?? 401, { ok: false, error: 'UNAUTHORIZED' });
  };
  return { calls, fetchImpl };
}

test('post-deploy verifier proves exact commit, RC2 version, live-off and public shadow lock', async () => {
  const { calls, fetchImpl } = mockFetch();
  const result = await verifyDeployment({ expectedCommit: COMMIT, fetchImpl });
  assert.equal(result.passed, true);
  assert.equal(result.observed.publicForwardShadowStatus, 401);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.method === 'GET'));
  assert.ok(calls.every((call) => !('Authorization' in call.options.headers)));
  assert.equal(result.checks.brokerNotCalled, true);
  assert.equal(result.checks.orderEndpointNotCalled, true);
  assert.equal(result.checks.moneyNotMoving, true);
});

test('post-deploy verifier fails when live trading is enabled', async () => {
  const { fetchImpl } = mockFetch({ liveTradingEnabled: true });
  const result = await verifyDeployment({ expectedCommit: COMMIT, fetchImpl });
  assert.equal(result.passed, false);
  assert.equal(result.checks.liveTradingDisabled, false);
});

test('post-deploy verifier fails until the forward-shadow route is deployed and locked', async () => {
  const { fetchImpl } = mockFetch({ shadowStatus: 404 });
  const result = await verifyDeployment({ expectedCommit: COMMIT, fetchImpl });
  assert.equal(result.passed, false);
  assert.equal(result.checks.publicForwardShadowLocked, false);
});

test('post-deploy verifier accepts HTTPS only and requires a full commit hash', async () => {
  await assert.rejects(() => verifyDeployment({
    expectedCommit: COMMIT,
    baseUrl: 'http://example.test',
    fetchImpl: mockFetch().fetchImpl,
  }), /BASE_URL_HTTPS_REQUIRED/);
  await assert.rejects(() => verifyDeployment({
    expectedCommit: 'abc1234',
    fetchImpl: mockFetch().fetchImpl,
  }), /EXPECTED_COMMIT_INVALID/);
});
