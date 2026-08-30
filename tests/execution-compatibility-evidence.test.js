const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const evidence = require('../config/dr-execution-compatibility-rc2.json');
const { verifyExecutionCompatibilityEvidence } = require('../netlify/lib/real-money-release');

function hashFile(relativePath) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.resolve(__dirname, '..', relativePath)))
    .digest('hex');
}

function canonicalTextHash(relativePath) {
  const text = fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('DR execution compatibility evidence is file-bound and semantically verified', () => {
  const relativePath = 'config/dr-execution-compatibility-rc2.json';
  assert.equal(verifyExecutionCompatibilityEvidence({
    path: relativePath,
    sha256: hashFile(relativePath),
  }), true);
  assert.equal(evidence.implementationHashScheme, 'SHA256_UTF8_CANONICAL_LF_V1');
  assert.ok(evidence.implementationRefs.every((reference) => canonicalTextHash(reference.path) === reference.sha256));
});

test('local compatibility evidence cannot unlock release flags by itself', () => {
  assert.equal(evidence.productionLockedDuringVerification, true);
  assert.equal(evidence.brokerCalled, false);
  assert.equal(evidence.moneyMoving, false);
  assert.equal(evidence.releaseState.executionCompatibilityVerified, false);
  assert.equal(evidence.releaseState.forwardShadowVerified, false);
  assert.equal(evidence.releaseState.strategyReleaseApproved, false);
  assert.equal(evidence.releaseState.liveTradingEnabled, false);
});
