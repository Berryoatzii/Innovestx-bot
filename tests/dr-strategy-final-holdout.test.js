const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const candidate = require('../config/dr-strategy-research-candidate-rc2.json');
const evidence = require('../config/dr-strategy-final-holdout-rc2.json');

test('RC2 final holdout evidence is bound to the frozen candidate', () => {
  const candidatePath = path.resolve(__dirname, '../config/dr-strategy-research-candidate-rc2.json');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(candidatePath)).digest('hex');
  assert.equal(hash, evidence.candidateSha256);
  assert.equal(evidence.candidateId, candidate.candidateId);
  assert.equal(evidence.strategyVersion, candidate.strategyVersion);
  assert.equal(evidence.frozenCommit, 'c8a2d2d70fc7ec908d3bdfc7d6d3dc0049c2c1b4');
});

test('RC2 final holdout passed every frozen stress gate without unlocking production', () => {
  assert.equal(evidence.finalHoldoutOpened, true);
  assert.equal(evidence.startMonth, candidate.validationDesign.finalHoldout.startMonth);
  assert.equal(evidence.completedThroughMonth, '2026-07');
  assert.equal(evidence.passed, true);
  assert.equal(evidence.scenarios.length, candidate.validationDesign.stressTurnoverCostRates.length);
  assert.ok(evidence.scenarios.every((row) => row.gate.passed));
  assert.equal(evidence.releaseLocks.memberStrategyApprovalRequired, true);
  assert.equal(evidence.releaseLocks.shadowEvidenceRequired, true);
  assert.equal(evidence.releaseLocks.strategyReleaseApproved, false);
  assert.equal(evidence.releaseLocks.liveTradingEnabled, false);
});

test('one-time holdout tool refuses to run again after durable evidence exists', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../tools/local-dr-final-holdout-once.js'),
    'utf8',
  );
  assert.equal(source.includes("throw new Error('FINAL_HOLDOUT_ALREADY_OPENED')"), true);
  assert.equal(fs.existsSync(path.resolve(__dirname, '../config/dr-strategy-final-holdout-rc2.json')), true);
});
