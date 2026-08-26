const test = require('node:test');
const assert = require('node:assert/strict');

const { loadReleaseConfig, parseRuntimeEvidence } = require('../netlify/lib/release-config');

test('checked-in release config is always fail-closed', () => {
  const config = loadReleaseConfig({});
  assert.equal(config.brokerPermissionConfirmed, false);
  assert.equal(config.productionReadOnlyVerified, false);
  assert.deepEqual(config.evidenceRefs, {});
});

test('runtime evidence can be supplied through a private base64 environment value', () => {
  const evidence = { schemaVersion: 2, brokerPermissionConfirmed: true };
  const encoded = Buffer.from(JSON.stringify(evidence), 'utf8').toString('base64');
  assert.deepEqual(parseRuntimeEvidence({ REAL_MONEY_RELEASE_EVIDENCE_B64: encoded }), evidence);
});

test('invalid runtime evidence falls back to the checked-in fail-closed config', () => {
  const config = loadReleaseConfig({ REAL_MONEY_RELEASE_EVIDENCE_JSON: '{not-json' });
  assert.equal(config.brokerPermissionConfirmed, false);
  assert.equal(config.strategyReleaseApproved, false);
});
