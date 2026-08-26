const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluatePrivateWorkerReadiness } = require('../netlify/lib/private-worker-readiness');
const releaseManifest = require('../config/real-money-release.json');

const completeEvidence = {
  privateHost: true,
  gatewayLoopbackOnly: true,
  persistentJournal: true,
  watchdogEnabled: true,
  secretsProtected: true,
  singleSessionFence: true,
  reconciliationEnabled: true,
  alertsVerified: true,
  restartDrillPassed: true,
  networkOutageDrillPassed: true,
  lastVerifiedAt: '2026-08-05T00:00:00.000Z',
  deployedCommit: 'abc1234',
  auditedCommit: 'abc1234',
};

test('private worker passes only with recent runtime and outage evidence', () => {
  const result = evaluatePrivateWorkerReadiness(
    completeEvidence,
    new Date('2026-08-06T00:00:00.000Z'),
  );

  assert.equal(result.passed, true);
  assert.deepEqual(result.blockers, []);
});

test('public exposure, stale drills and mismatched deployment fail closed', () => {
  const result = evaluatePrivateWorkerReadiness(
    {
      ...completeEvidence,
      gatewayLoopbackOnly: false,
      lastVerifiedAt: '2026-06-01T00:00:00.000Z',
      auditedCommit: 'different',
    },
    new Date('2026-08-06T00:00:00.000Z'),
  );

  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('WORKER_GATEWAY_NOT_PRIVATE'));
  assert.ok(result.blockers.includes('WORKER_VERIFICATION_STALE'));
  assert.ok(result.blockers.includes('WORKER_COMMIT_MISMATCH'));
});

test('a private worker flag without drill evidence can never pass', () => {
  const result = evaluatePrivateWorkerReadiness({ privateWorkerVerified: true });

  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('WORKER_RESTART_DRILL_MISSING'));
  assert.ok(result.blockers.includes('WORKER_OUTAGE_DRILL_MISSING'));
});

test('checked-in release manifest remains fail-closed before the production worker is complete', () => {
  const result = evaluatePrivateWorkerReadiness(releaseManifest.privateWorkerEvidence);

  assert.equal(result.passed, false);
  assert.ok(result.blockers.includes('WORKER_WATCHDOG_MISSING'));
  assert.ok(result.blockers.includes('WORKER_OUTAGE_DRILL_MISSING'));
  assert.ok(result.blockers.includes('WORKER_DEPLOYED_COMMIT_MISSING'));
});
