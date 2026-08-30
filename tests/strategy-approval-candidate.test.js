const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const candidate = require('../config/strategy-approval-candidate.json');
const frozen = require('../config/dr-strategy-research-candidate-rc2.json');
const finalHoldout = require('../config/dr-strategy-final-holdout-rc2.json');
const universe = require('../config/research-universe-dr-pilot-2026.json');

function hashFile(relativePath) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.resolve(__dirname, '..', relativePath)))
    .digest('hex');
}

test('member approval candidate is bound to frozen RC2 logic and final holdout evidence', () => {
  assert.equal(candidate.candidateId, frozen.candidateId);
  assert.equal(candidate.strategyVersion, frozen.strategyVersion);
  assert.equal(candidate.researchEvidence.frozenCandidate.sha256, hashFile(candidate.researchEvidence.frozenCandidate.path));
  assert.equal(candidate.researchEvidence.finalHoldout.sha256, hashFile(candidate.researchEvidence.finalHoldout.path));
  assert.equal(candidate.researchEvidence.finalHoldout.passed, true);
  assert.equal(finalHoldout.passed, true);
  assert.equal(candidate.signalLogic.momentumMonths, frozen.signalLogic.momentumMonths);
  assert.equal(candidate.signalLogic.retentionRank, frozen.signalLogic.retentionRank);
  assert.equal(candidate.signalLogic.maximumSelected, frozen.signalLogic.maximumSelected);
  assert.equal(candidate.approvalScope.symbols.length, universe.instruments.length);
  assert.deepEqual(candidate.approvalScope.symbols, universe.instruments.map((item) => item.symbol));
});

test('candidate remains fail-closed and scopes full exits to candidate DR positions', () => {
  assert.equal(candidate.approvalStatus, 'PENDING_MEMBER_APPROVAL');
  assert.equal(candidate.approvalScope.humanApprovalPerOrder, true);
  assert.equal(candidate.approvalScope.continuousAutomation, false);
  assert.deepEqual(candidate.approvalScope.requestedPermissions, { place: true, change: true, cancel: true });
  assert.equal(candidate.orderAndExecutionControls.orderType, 'RESTING_LIMIT_ONLY');
  assert.equal(candidate.orderAndExecutionControls.marketOrdersAllowed, false);
  assert.equal(candidate.orderAndExecutionControls.auctionOrdersAllowed, false);
  assert.equal(candidate.orderAndExecutionControls.fullPositionExitAllowed, true);
  assert.equal(candidate.orderAndExecutionControls.fullPositionExitScope, 'CANDIDATE_DR_POSITIONS_ONLY');
  assert.equal(candidate.orderAndExecutionControls.automaticBrokerRetry, false);
  assert.equal(candidate.releaseConditions.executionCompatibilityEvidenceRequired, true);
  assert.equal(candidate.releaseConditions.forwardShadowEvidenceRequired, true);
  assert.equal(candidate.releaseConditions.strategyReleaseApproved, false);
  assert.equal(candidate.releaseConditions.liveTradingEnabled, false);
});

test('candidate carries no account or credential material', () => {
  assert.deepEqual(candidate.privacy, {
    containsAccountIdentifier: false,
    containsCredential: false,
    containsPin: false,
    containsToken: false,
  });
  const serialized = JSON.stringify(candidate);
  assert.equal(
    /\"(?:appId|appSecret|accountNo|accountNumber|pin|token|privateKey)\"\s*:\s*\"[^\"]+\"/i.test(serialized),
    false,
  );
});

test('approval request is bound to the exact RC2 candidate hash', () => {
  const candidatePath = path.resolve(__dirname, '../config/strategy-approval-candidate.json');
  const requestPath = path.resolve(__dirname, '../docs/AEGIS_STRATEGY_APPROVAL_REQUEST_TH.md');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(candidatePath)).digest('hex');
  const request = fs.readFileSync(requestPath, 'utf8');

  assert.equal(hash, '609a4773b6a9f8bd93e103ba3cd36fa310402adcec4e82d27a187511d4262059');
  assert.equal(request.includes(hash), true);
  assert.equal(request.includes(candidate.candidateId), true);
  assert.equal(request.includes(candidate.strategyVersion), true);
});
