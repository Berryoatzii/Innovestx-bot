const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { evaluatePrivateWorkerReadiness } = require('./private-worker-readiness');
const { evaluatePilotCapital } = require('./pilot-capital-feasibility');

const REQUIRED_BOOLEAN_EVIDENCE = [
  'uatOrderCycleComplete',
  'uatFaultMatrixComplete',
  'brokerPermissionConfirmed',
  'productionReadOnlyVerified',
  'zeroUnresolvedVerified',
  'strategyReleaseApproved',
];

const COMMON_FILE_BACKED_EVIDENCE = [
  'uatOrderCycleComplete',
  'brokerPermissionConfirmed',
  'productionReadOnlyVerified',
  'zeroUnresolvedVerified',
];

const FULL_RELEASE_FILE_BACKED_EVIDENCE = [
  ...COMMON_FILE_BACKED_EVIDENCE,
  'strategyReleaseApproved',
];

function verifyEvidenceRef(reference = {}, root = path.resolve(__dirname, '../..')) {
  const relativePath = String(reference.path || '').trim().replace(/\\/g, '/');
  const expectedHash = String(reference.sha256 || '').trim().toLowerCase();
  if (!relativePath || path.isAbsolute(relativePath) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return false;
  try {
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(resolvedPath)).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash));
  } catch {
    return false;
  }
}

function loadVerifiedEvidenceJson(reference = {}, root = path.resolve(__dirname, '../..')) {
  if (!verifyEvidenceRef(reference, root)) return null;
  const relativePath = String(reference.path || '').trim().replace(/\\/g, '/');
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function verifyBrokerPermissionEvidence(reference = {}, root = path.resolve(__dirname, '../..')) {
  const value = loadVerifiedEvidenceJson(reference, root);
  return value?.evidenceType === 'BROKER_OPEN_API_ACCOUNT_ACTIVATION'
    && value.accountLevelOpenApiActivated === true
    && value.apiKeyProvisioningOffered === true
    && value.strategyLogicParametersApproved === false
    && value.accountIdentifiersRedacted === true
    && value.secretMaterialPresent === false;
}

function verifyStrategyApprovalEvidence(reference = {}, root = path.resolve(__dirname, '../..')) {
  const evidence = loadVerifiedEvidenceJson(reference, root);
  if (!evidence) return false;
  const resolvedRoot = path.resolve(root);
  const candidatePath = path.resolve(resolvedRoot, 'config/strategy-approval-candidate.json');
  if (!candidatePath.startsWith(`${resolvedRoot}${path.sep}`)) return false;
  try {
    const candidateBytes = fs.readFileSync(candidatePath);
    const candidate = JSON.parse(candidateBytes.toString('utf8'));
    const candidateSha256 = crypto.createHash('sha256').update(candidateBytes).digest('hex');
    const approvedAt = Date.parse(String(evidence.approvedAt || ''));
    return evidence.evidenceType === 'BROKER_MEMBER_STRATEGY_APPROVAL'
      && evidence.member === candidate.approvalScope?.member
      && evidence.approved === true
      && evidence.candidateId === candidate.candidateId
      && evidence.strategyVersion === candidate.strategyVersion
      && evidence.candidateSha256 === candidateSha256
      && evidence.permissionScope?.place === true
      && evidence.permissionScope?.change === true
      && evidence.permissionScope?.cancel === true
      && Number.isFinite(approvedAt)
      && evidence.accountIdentifiersRedacted === true
      && evidence.secretMaterialPresent === false;
  } catch {
    return false;
  }
}

function runtimeCommitEvidence(input = {}, options = {}) {
  return {
    deployedCommit: String(
      options.deployedCommit || process.env.COMMIT_REF || process.env.DEPLOYED_COMMIT_REF || input.deployedCommit || ''
    ).trim(),
    auditedCommit: String(
      options.auditedCommit || process.env.AUDITED_COMMIT_REF || input.auditedCommit || ''
    ).trim(),
  };
}

function evaluateReleaseEvidence(input = {}, options = {}) {
  const checks = Object.fromEntries(
    REQUIRED_BOOLEAN_EVIDENCE.map((key) => [key, input[key] === true]),
  );
  if (Number(input.schemaVersion || 0) >= 2) {
    for (const key of FULL_RELEASE_FILE_BACKED_EVIDENCE) {
      checks[key] = checks[key] && verifyEvidenceRef(input.evidenceRefs?.[key]);
    }
    checks.brokerPermissionConfirmed = checks.brokerPermissionConfirmed
      && verifyBrokerPermissionEvidence(input.evidenceRefs?.brokerPermissionConfirmed);
    checks.strategyReleaseApproved = checks.strategyReleaseApproved
      && verifyStrategyApprovalEvidence(input.evidenceRefs?.strategyReleaseApproved);
  }
  const commitEvidence = runtimeCommitEvidence(input, options);
  const privateWorker = evaluatePrivateWorkerReadiness(
    input.privateWorkerEvidence || {},
    options.now || new Date(),
    commitEvidence,
  );
  checks.privateWorkerVerified = privateWorker.passed;
  const pilotCapital = evaluatePilotCapital(input.pilotCapitalEvidence || {});
  checks.pilotCapitalFeasible = pilotCapital.passed;
  if (Number(input.schemaVersion || 0) >= 2) {
    checks.pilotCapitalFeasible = checks.pilotCapitalFeasible
      && verifyEvidenceRef(input.evidenceRefs?.pilotCapitalEvidence);
  }
  const { deployedCommit, auditedCommit } = commitEvidence;
  checks.commitPinned = deployedCommit.length >= 7;
  checks.auditedCommitMatchesDeployment = checks.commitPinned && deployedCommit === auditedCommit;
  const blockers = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => `RELEASE_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`);
  return {
    passed: blockers.length === 0,
    checks,
    blockers,
    deployedCommit: checks.commitPinned ? deployedCommit : null,
    privateWorker,
    pilotCapital,
  };
}

function evaluateOperationalPilotEvidence(input = {}, options = {}) {
  const requiredEvidence = [
    'uatOrderCycleComplete',
    'uatFaultMatrixComplete',
    'brokerPermissionConfirmed',
    'productionReadOnlyVerified',
    'zeroUnresolvedVerified',
    'humanApprovalVerified',
    'oneOrderKillSwitchVerified',
  ];
  const checks = Object.fromEntries(
    requiredEvidence.map((key) => [key, input[key] === true]),
  );
  if (Number(input.schemaVersion || 0) >= 2) {
    for (const key of COMMON_FILE_BACKED_EVIDENCE) {
      checks[key] = checks[key] && verifyEvidenceRef(input.evidenceRefs?.[key]);
    }
    checks.brokerPermissionConfirmed = checks.brokerPermissionConfirmed
      && verifyBrokerPermissionEvidence(input.evidenceRefs?.brokerPermissionConfirmed);
  }
  const commitEvidence = runtimeCommitEvidence(input, options);
  const privateWorker = evaluatePrivateWorkerReadiness(
    input.privateWorkerEvidence || {},
    options.now || new Date(),
    commitEvidence,
  );
  checks.privateWorkerVerified = privateWorker.passed;
  const pilotCapital = evaluatePilotCapital(input.pilotCapitalEvidence || {});
  checks.pilotCapitalFeasible = pilotCapital.passed;
  if (Number(input.schemaVersion || 0) >= 2) {
    checks.pilotCapitalFeasible = checks.pilotCapitalFeasible
      && verifyEvidenceRef(input.evidenceRefs?.pilotCapitalEvidence);
  }
  checks.fullNotionalMode = pilotCapital.protectionMode === 'FULL_NOTIONAL_LONG_ONLY';
  const { deployedCommit, auditedCommit } = commitEvidence;
  checks.commitPinned = deployedCommit.length >= 7;
  checks.auditedCommitMatchesDeployment = checks.commitPinned && deployedCommit === auditedCommit;
  const blockerNames = {
    fullNotionalMode: 'OPERATIONAL_FULL_NOTIONAL_MODE_REQUIRED',
  };
  const blockers = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([key]) => blockerNames[key]
      || `OPERATIONAL_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`);
  const passed = blockers.length === 0;
  return {
    passed,
    checks,
    blockers,
    maxOrders: passed ? 1 : 0,
    automationEnabled: false,
    strategyApproved: false,
    deployedCommit: checks.commitPinned ? deployedCommit : null,
    privateWorker,
    pilotCapital,
  };
}

function deriveReadinessStages(input = {}) {
  const observeReady = input.brokerConnected === true && input.telegramReady === true;
  const researchReady = observeReady
    && input.classificationComplete === true
    && input.hasResearchSymbols === true;
  const proposalReady = researchReady
    && Number(input.activePassed || 0) > 0
    && input.shadowPassed === true;
  const livePilotReady = proposalReady
    && input.approvalReady === true
    && input.releasePassed === true
    && Array.isArray(input.blockers)
    && input.blockers.length === 0;
  return { observeReady, researchReady, proposalReady, livePilotReady };
}

module.exports = {
  evaluateOperationalPilotEvidence,
  evaluateReleaseEvidence,
  deriveReadinessStages,
  verifyEvidenceRef,
  verifyBrokerPermissionEvidence,
  verifyStrategyApprovalEvidence,
  runtimeCommitEvidence,
};
