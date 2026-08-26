const REQUIRED_BOOLEAN_EVIDENCE = [
  ['privateHost', 'WORKER_PRIVATE_HOST_UNVERIFIED'],
  ['gatewayLoopbackOnly', 'WORKER_GATEWAY_NOT_PRIVATE'],
  ['persistentJournal', 'WORKER_PERSISTENT_JOURNAL_MISSING'],
  ['watchdogEnabled', 'WORKER_WATCHDOG_MISSING'],
  ['secretsProtected', 'WORKER_SECRETS_UNPROTECTED'],
  ['singleSessionFence', 'WORKER_SESSION_FENCE_MISSING'],
  ['reconciliationEnabled', 'WORKER_RECONCILIATION_MISSING'],
  ['alertsVerified', 'WORKER_ALERTS_UNVERIFIED'],
  ['restartDrillPassed', 'WORKER_RESTART_DRILL_MISSING'],
  ['networkOutageDrillPassed', 'WORKER_OUTAGE_DRILL_MISSING'],
];

function evaluatePrivateWorkerReadiness(input = {}, now = new Date(), options = {}) {
  const blockers = [];
  const checks = {};

  for (const [key, blocker] of REQUIRED_BOOLEAN_EVIDENCE) {
    checks[key] = input[key] === true;
    if (!checks[key]) blockers.push(blocker);
  }

  const verifiedAt = new Date(input.lastVerifiedAt || '');
  const currentTime = now instanceof Date ? now : new Date(now);
  const verifiedTime = verifiedAt.getTime();
  const currentTimestamp = currentTime.getTime();
  checks.verificationTimestampValid = Number.isFinite(verifiedTime) && Number.isFinite(currentTimestamp);
  checks.verificationRecent = false;
  if (!checks.verificationTimestampValid) {
    blockers.push('WORKER_VERIFICATION_MISSING');
  } else {
    const ageMs = currentTimestamp - verifiedTime;
    if (ageMs < -5 * 60 * 1000) blockers.push('WORKER_VERIFICATION_IN_FUTURE');
    else if (ageMs > 30 * 24 * 60 * 60 * 1000) blockers.push('WORKER_VERIFICATION_STALE');
    else checks.verificationRecent = true;
  }

  const deployedCommit = String(options.deployedCommit || input.deployedCommit || '').trim();
  const auditedCommit = String(options.auditedCommit || input.auditedCommit || '').trim();
  checks.commitPinned = deployedCommit.length >= 7;
  checks.commitMatches = checks.commitPinned && deployedCommit === auditedCommit;
  if (!checks.commitPinned) blockers.push('WORKER_DEPLOYED_COMMIT_MISSING');
  else if (!checks.commitMatches) blockers.push('WORKER_COMMIT_MISMATCH');

  return {
    passed: blockers.length === 0,
    checks,
    blockers,
    lastVerifiedAt: checks.verificationTimestampValid ? verifiedAt.toISOString() : null,
    deployedCommit: checks.commitPinned ? deployedCommit : null,
  };
}

module.exports = { evaluatePrivateWorkerReadiness };
