const test = require('node:test');
const assert = require('node:assert/strict');

function clear(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; } catch {}
}

test.afterEach(() => {
  delete process.env.PRIVATE_WORKER_TOKEN;
  delete process.env.ORDER_INTENT_GATE_SECRET;
  delete process.env.EXECUTION_TOPOLOGY;
  clear('../netlify/lib/private-worker-queue');
  clear('../netlify/lib/approval-executor');
});

test('worker authentication fails closed and uses timing-safe equality', () => {
  process.env.PRIVATE_WORKER_TOKEN = 'worker-secret';
  clear('../netlify/lib/private-worker-queue');
  const { workerAuthorized } = require('../netlify/lib/private-worker-queue');
  assert.equal(workerAuthorized({ 'x-private-worker-token': 'worker-secret' }), true);
  assert.equal(workerAuthorized({ 'X-Private-Worker-Token': 'wrong' }), false);
  assert.equal(workerAuthorized({}), false);
});

test('claimed payload signature binds every money-moving field', () => {
  process.env.ORDER_INTENT_GATE_SECRET = 'intent-secret';
  clear('../netlify/lib/private-worker-queue');
  const { _test } = require('../netlify/lib/private-worker-queue');
  const payload = {
    intentId: '0123456789abcdef', claimId: 'a'.repeat(32), symbol: 'TTB', side: 'BUY',
    quantity: 100, price: 2.9, orderStyle: 'RESTING_LIMIT', expiresAt: '2026-08-26T10:00:00Z',
  };
  const signed = _test.signWorkerPayload(payload);
  assert.match(signed, /^[a-f0-9]{64}$/);
  assert.notEqual(signed, _test.signWorkerPayload({ ...payload, price: 2.92 }));
  assert.notEqual(signed, _test.signWorkerPayload({ ...payload, quantity: 200 }));
});

test('worker can submit only the exact approved resting Limit order', () => {
  const { _test } = require('../netlify/lib/private-worker-queue');
  const intent = {
    symbol: 'TTB', side: 'BUY', quantity: 100, proposedPrice: 2.9, orderStyle: 'RESTING_LIMIT',
  };
  assert.deepEqual(_test.assertExactOrder(intent, {
    symbol: 'TTB', side: 'BUY', quantity: 100, price: 2.9,
  }), { symbol: 'TTB', side: 'BUY', quantity: 100, price: 2.9 });
  assert.throws(() => _test.assertExactOrder(intent, {
    symbol: 'TTB', side: 'BUY', quantity: 100, price: 2.92,
  }), /DOES_NOT_MATCH/);
  assert.throws(() => _test.assertExactOrder({ ...intent, orderStyle: 'MARKETABLE_LIMIT' }, {
    symbol: 'TTB', side: 'BUY', quantity: 100, price: 2.9,
  }), /REQUIRES_RESTING_LIMIT/);
});

test('private-worker topology never requires a public broker gateway URL', () => {
  Object.assign(process.env, {
    EXECUTION_TOPOLOGY: 'PRIVATE_WORKER_QUEUE',
    PRIVATE_WORKER_TOKEN: 'worker-secret',
    ORDER_INTENT_GATE_SECRET: 'intent-secret',
    LIVE_TRADING_ENABLED: 'true',
    HUMAN_APPROVAL_LIVE_ENABLED: 'true',
    OPERATIONAL_PILOT_MODE: 'true',
    MAX_LIVE_ORDER_VALUE: '1000',
    MAX_DAILY_APPROVED_NOTIONAL: '1000',
  });
  clear('../netlify/lib/approval-executor');
  const { approvalAvailability } = require('../netlify/lib/approval-executor');
  const now = new Date().toISOString();
  const releaseManifest = {
    uatOrderCycleComplete: true, uatFaultMatrixComplete: true, brokerPermissionConfirmed: true,
    productionReadOnlyVerified: true, zeroUnresolvedVerified: true, humanApprovalVerified: true,
    oneOrderKillSwitchVerified: true, deployedCommit: 'abc1234', auditedCommit: 'abc1234',
    privateWorkerEvidence: {
      privateHost: true, gatewayLoopbackOnly: true, persistentJournal: true, watchdogEnabled: true,
      secretsProtected: true, singleSessionFence: true, reconciliationEnabled: true, alertsVerified: true,
      restartDrillPassed: true, networkOutageDrillPassed: true, lastVerifiedAt: now,
      deployedCommit: 'abc1234', auditedCommit: 'abc1234',
    },
    pilotCapitalEvidence: {
      capital: 100000, price: 2.9, stopPrice: null, protectionMode: 'FULL_NOTIONAL_LONG_ONLY',
      accountType: 'CASH_BALANCE', longOnly: true, fullyPaid: true, boardLot: 100, tickSize: 0.01,
      maxPositionWeight: 0.05, riskPerTradePct: 0.005, cashReserveWeight: 0.2,
      feesVerified: true, protectionVerified: true,
      costModel: {
        commissionRate: 0.0015, setTradingFeeRate: 0.00005, clearingFeeRate: 0.00001,
        regulatoryFeeRate: 0.00001, vatRate: 0.07, slippageBpsPerSide: 10, minimumCommissionPerDay: 0,
      },
    },
  };
  const availability = approvalAvailability({ releaseManifest });
  assert.equal(availability.ready, true);
  assert.equal(availability.executionTopology, 'PRIVATE_WORKER_QUEUE');
  assert.equal(availability.gatewayTopologyAllowed, true);
  assert.equal(availability.missing.includes('BROKER_GATEWAY_URL'), false);
});
