const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const candidate = require('../config/dr-strategy-research-candidate-rc2.json');

function fileHash(relativePath) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.resolve(__dirname, '..', relativePath)))
    .digest('hex');
}

test('RC2 research candidate is hash-bound to its frozen universe and implementation', () => {
  assert.equal(fileHash(candidate.universeRef.path), candidate.universeRef.sha256);
  for (const reference of candidate.implementationRefs) {
    assert.equal(fileHash(reference.path), reference.sha256);
  }
});

test('RC2 remains sealed, research-only and unable to authorize production', () => {
  assert.equal(candidate.candidateStatus, 'FROZEN_FOR_FINAL_HOLDOUT');
  assert.equal(candidate.authority, 'RESEARCH_ONLY_NO_ORDERS');
  assert.equal(candidate.validationDesign.finalHoldout.opened, false);
  assert.equal(candidate.releaseLocks.memberStrategyApprovalRequired, true);
  assert.equal(candidate.releaseLocks.shadowEvidenceRequired, true);
  assert.equal(candidate.releaseLocks.humanApprovalPerOrderRequired, true);
  assert.equal(candidate.releaseLocks.strategyReleaseApproved, false);
  assert.equal(candidate.releaseLocks.liveTradingEnabled, false);
});

test('RC2 carries no account, credential, PIN or token material', () => {
  assert.deepEqual(candidate.privacy, {
    containsAccountIdentifier: false,
    containsCredential: false,
    containsPin: false,
    containsToken: false,
  });
});
