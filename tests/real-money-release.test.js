const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateOperationalPilotEvidence,
  evaluateReleaseEvidence,
  deriveReadinessStages,
  runtimeCommitEvidence,
  verifyEvidenceRef,
} = require('../netlify/lib/real-money-release');
const releaseManifest = require('../config/real-money-release.json');

test('deployment commit comes from runtime attestation without a self-referential manifest edit', () => {
  const evidence = runtimeCommitEvidence(
    { deployedCommit: 'manifest-old', auditedCommit: 'manifest-old' },
    { deployedCommit: 'runtime123', auditedCommit: 'runtime123' },
  );
  assert.deepEqual(evidence, { deployedCommit: 'runtime123', auditedCommit: 'runtime123' });
});

const privateWorkerEvidence = {
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
  lastVerifiedAt: new Date().toISOString(),
  deployedCommit: 'abc1234',
  auditedCommit: 'abc1234',
};

const pilotCapitalEvidence = {
  capital: 10000,
  price: 1.90,
  stopPrice: 1.80,
  boardLot: 100,
  tickSize: 0.01,
  maxPositionWeight: 0.05,
  riskPerTradePct: 0.005,
  cashReserveWeight: 0.20,
  feesVerified: true,
  protectionVerified: true,
  costModel: {
    commissionRate: 0.0015,
    setTradingFeeRate: 0.00005,
    clearingFeeRate: 0.00001,
    regulatoryFeeRate: 0.00001,
    vatRate: 0.07,
    slippageBpsPerSide: 10,
    minimumCommissionPerDay: 0,
  },
};

test('live flags alone can never mark a real-money pilot ready', () => {
  const evidence = evaluateReleaseEvidence({});
  const stages = deriveReadinessStages({
    brokerConnected: true,
    telegramReady: true,
    classificationComplete: true,
    hasResearchSymbols: true,
    activePassed: 1,
    shadowPassed: true,
    approvalReady: true,
    releasePassed: evidence.passed,
    blockers: [],
  });
  assert.equal(evidence.passed, false);
  assert.equal(stages.livePilotReady, false);
});

test('checked-in release manifest remains locked after capital evidence alone', () => {
  const evidence = evaluateReleaseEvidence(releaseManifest);
  const operational = evaluateOperationalPilotEvidence(releaseManifest);

  assert.equal(evidence.passed, false);
  assert.equal(operational.passed, false);
  assert.equal(operational.maxOrders, 0);
  assert.equal(evidence.checks.pilotCapitalFeasible, false);
  assert.equal(evidence.checks.privateWorkerVerified, false);
});

test('file-backed release evidence is hash-bound and rejects missing or tampered files', () => {
  const fixturePath = path.resolve(__dirname, '../package.json');
  const reference = {
    path: 'package.json',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'),
  };
  assert.equal(verifyEvidenceRef(reference), true);
  assert.equal(verifyEvidenceRef({ ...reference, sha256: '0'.repeat(64) }), false);
  assert.equal(verifyEvidenceRef({ path: '../outside.json', sha256: reference.sha256 }), false);
  assert.equal(evaluateReleaseEvidence({
    ...releaseManifest,
    evidenceRefs: {
      ...releaseManifest.evidenceRefs,
      uatOrderCycleComplete: { ...reference, sha256: '0'.repeat(64) },
    },
  }).checks.uatOrderCycleComplete, false);
});

test('release evidence requires every safety proof and matching audited deployment', () => {
  const complete = {
    uatOrderCycleComplete: true,
    uatFaultMatrixComplete: true,
    privateWorkerEvidence,
    brokerPermissionConfirmed: true,
    productionReadOnlyVerified: true,
    zeroUnresolvedVerified: true,
    strategyReleaseApproved: true,
    pilotCapitalEvidence,
    deployedCommit: 'abc1234',
    auditedCommit: 'abc1234',
  };
  assert.equal(evaluateReleaseEvidence(complete).passed, true);
  assert.equal(evaluateReleaseEvidence({ ...complete, auditedCommit: 'different' }).passed, false);
  assert.equal(evaluateReleaseEvidence({
    ...complete,
    pilotCapitalEvidence: undefined,
    pilotCapitalFeasible: true,
  }).passed, false);
  assert.equal(evaluateReleaseEvidence({ ...complete, privateWorkerEvidence: undefined }).passed, false);
});

test('a tiny full-notional operational pilot never substitutes for strategy approval', () => {
  const operationalPilot = {
    capital: 3500,
    price: 3.22,
    stopPrice: null,
    boardLot: 1,
    tickSize: 0.01,
    maxPositionWeight: 0.05,
    riskPerTradePct: 0.005,
    cashReserveWeight: 0.20,
    feesVerified: true,
    protectionVerified: false,
    protectionMode: 'FULL_NOTIONAL_LONG_ONLY',
    accountType: 'CASH_BALANCE',
    longOnly: true,
    fullyPaid: true,
    costModel: pilotCapitalEvidence.costModel,
  };
  const evidence = evaluateReleaseEvidence({
    uatOrderCycleComplete: true,
    uatFaultMatrixComplete: true,
    privateWorkerEvidence,
    brokerPermissionConfirmed: true,
    productionReadOnlyVerified: true,
    zeroUnresolvedVerified: true,
    strategyReleaseApproved: false,
    pilotCapitalEvidence: operationalPilot,
    deployedCommit: 'abc1234',
    auditedCommit: 'abc1234',
  });

  assert.equal(evidence.pilotCapital.passed, true);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.blockers.includes('RELEASE_STRATEGY_RELEASE_APPROVED'));
});

test('one-order operational pilot can pass separately while strategy automation remains locked', () => {
  const operational = evaluateOperationalPilotEvidence({
    uatOrderCycleComplete: true,
    uatFaultMatrixComplete: true,
    privateWorkerEvidence,
    brokerPermissionConfirmed: true,
    productionReadOnlyVerified: true,
    zeroUnresolvedVerified: true,
    humanApprovalVerified: true,
    oneOrderKillSwitchVerified: true,
    pilotCapitalEvidence: {
      capital: 3500,
      price: 3.22,
      stopPrice: null,
      boardLot: 1,
      tickSize: 0.01,
      maxPositionWeight: 0.05,
      riskPerTradePct: 0.005,
      cashReserveWeight: 0.20,
      feesVerified: true,
      protectionMode: 'FULL_NOTIONAL_LONG_ONLY',
      accountType: 'CASH_BALANCE',
      longOnly: true,
      fullyPaid: true,
      costModel: pilotCapitalEvidence.costModel,
    },
    deployedCommit: 'abc1234',
    auditedCommit: 'abc1234',
  });

  assert.equal(operational.passed, true);
  assert.equal(operational.maxOrders, 1);
  assert.equal(operational.automationEnabled, false);
  assert.equal(operational.strategyApproved, false);
});

test('operational pilot fails closed for stop-dependent evidence or raw bypass flags', () => {
  const result = evaluateOperationalPilotEvidence({
    uatOrderCycleComplete: true,
    uatFaultMatrixComplete: true,
    privateWorkerEvidence,
    brokerPermissionConfirmed: true,
    productionReadOnlyVerified: true,
    zeroUnresolvedVerified: true,
    humanApprovalVerified: true,
    oneOrderKillSwitchVerified: true,
    operationalPilotReady: true,
    pilotCapitalEvidence,
    deployedCommit: 'abc1234',
    auditedCommit: 'abc1234',
  });

  assert.equal(result.passed, false);
  assert.equal(result.maxOrders, 0);
  assert.equal(result.automationEnabled, false);
  assert.ok(result.blockers.includes('OPERATIONAL_FULL_NOTIONAL_MODE_REQUIRED'));
});
