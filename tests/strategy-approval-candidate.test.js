const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const candidate = require('../config/strategy-approval-candidate.json');
const policy = require('../config/portfolio-policy.json');
const { RULE_VERSION } = require('../netlify/lib/deterministic-strategy');

test('member approval candidate is bound to the implemented deterministic strategy', () => {
  assert.equal(candidate.strategyVersion, RULE_VERSION);
  assert.equal(candidate.signalLogic.minimumDailyBars, policy.research.minimumBars);
  assert.equal(candidate.portfolioAndRiskParameters.activeSleeveTargetWeight, policy.targets.ACTIVE);
  assert.equal(candidate.portfolioAndRiskParameters.minimumCashTargetWeight, policy.targets.CASH);
  assert.equal(candidate.portfolioAndRiskParameters.maximumActivePositionWeight, policy.active.maxPositionWeight);
  assert.equal(candidate.portfolioAndRiskParameters.maximumActivePositions, policy.active.maxPositions);
  assert.equal(candidate.portfolioAndRiskParameters.riskPerTradeWeight, policy.active.riskPerTradePct);
  assert.equal(
    candidate.portfolioAndRiskParameters.minimumRewardToRiskAfterCosts,
    policy.active.minimumRewardToRiskAfterCosts,
  );
  assert.equal(candidate.releaseConditions.shadowMinimumTradingDays, policy.research.minimumShadowTradingDays);
  assert.equal(candidate.releaseConditions.shadowMinimumDecisionEvents, policy.research.minimumDecisionEvents);
  assert.equal(candidate.releaseConditions.shadowMinimumTradeEvents, policy.research.minimumShadowTradeEvents);
});

test('candidate remains fail-closed and cannot imply approval or live trading', () => {
  assert.equal(candidate.approvalStatus, 'PENDING_MEMBER_APPROVAL');
  assert.equal(candidate.approvalScope.humanApprovalPerOrder, true);
  assert.equal(candidate.approvalScope.continuousAutomation, false);
  assert.equal(candidate.orderAndExecutionControls.orderType, 'RESTING_LIMIT_ONLY');
  assert.equal(candidate.orderAndExecutionControls.marketOrdersAllowed, false);
  assert.equal(candidate.orderAndExecutionControls.auctionOrdersAllowed, false);
  assert.equal(candidate.orderAndExecutionControls.automaticBrokerRetry, false);
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
    /"(?:appId|appSecret|accountNo|accountNumber|pin|token|privateKey)"\s*:\s*"[^"]+"/i.test(serialized),
    false,
  );
});

test('approval request is bound to the exact candidate hash', () => {
  const candidatePath = path.resolve(__dirname, '../config/strategy-approval-candidate.json');
  const requestPath = path.resolve(__dirname, '../docs/AEGIS_STRATEGY_APPROVAL_REQUEST_TH.md');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(candidatePath)).digest('hex');
  const request = fs.readFileSync(requestPath, 'utf8');

  assert.equal(hash, '9ec7197a1899cdfa4ea9d6fdc847a0a9a926d06c039f40af0ee90d281cc2dae1');
  assert.equal(request.includes(hash), true);
  assert.equal(request.includes(candidate.candidateId), true);
  assert.equal(request.includes(candidate.strategyVersion), true);
});
