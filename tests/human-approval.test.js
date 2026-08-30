const test = require('node:test');
const assert = require('node:assert/strict');

function clear(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; } catch {}
}

function resetEnv() {
  for (const name of [
    'LIVE_TRADING_ENABLED',
    'HUMAN_APPROVAL_LIVE_ENABLED',
    'ADMIN_TOKEN',
    'EXECUTE_CONFIRMATION',
    'ORDER_INTENT_GATE_SECRET',
    'INVX_KEY',
    'INVX_SECRET',
    'INVX_PIN',
    'INVX_ACCOUNT',
    'BROKER_GATEWAY_URL',
    'BROKER_GATEWAY_TOKEN',
    'BROKER_GATEWAY_ENVIRONMENT',
    'MAX_LIVE_ORDER_VALUE',
    'MAX_DAILY_APPROVED_NOTIONAL',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_APPROVER_USER_ID',
    'TELEGRAM_WEBHOOK_SECRET',
  ]) delete process.env[name];
}

test.beforeEach(() => {
  resetEnv();
  clear('../netlify/lib/order-intent-store');
  clear('../netlify/lib/approval-executor');
  clear('../netlify/functions/invx');
  clear('../netlify/functions/telegram');
});

test('proposal sizing is capped by fraction and value', () => {
  const { calculateProposalQuantity } = require('../netlify/lib/order-intent-store');
  assert.equal(calculateProposalQuantity({
    positionQty: 2000,
    price: 10,
    maxFraction: 0.25,
    maxOrderValue: 3000,
    boardLot: 100,
  }), 300);
});

test('proposal sizing never produces a full-position exit', () => {
  const { calculateProposalQuantity } = require('../netlify/lib/order-intent-store');
  assert.equal(calculateProposalQuantity({
    positionQty: 100,
    price: 10,
    maxFraction: 0.25,
    maxOrderValue: 3000,
    boardLot: 100,
  }), 0);
});

test('intent schema rejects full-position exit', () => {
  const { buildIntent } = require('../netlify/lib/order-intent-store');
  assert.throws(() => buildIntent({
    idempotencyKey: 'test-key',
    symbol: 'TEST',
    side: 'SELL',
    quantity: 100,
    proposedPrice: 10,
    portfolioQty: 100,
  }), /FULL_POSITION_EXIT_NOT_ALLOWED/);
});

test('intent schema permits full exit only for the exact RC2 DR scope', () => {
  const candidate = require('../config/strategy-approval-candidate.json');
  const { buildIntent } = require('../netlify/lib/order-intent-store');
  const intent = buildIntent({
    idempotencyKey: 'rc2-dr-full-exit',
    symbol: candidate.approvalScope.symbols[0],
    side: 'SELL',
    quantity: 7,
    proposedPrice: 34.75,
    portfolioQty: 7,
    portfolioBucket: 'ACTIVE',
    orderStyle: 'RESTING_LIMIT',
    candidateId: candidate.candidateId,
    strategyVersion: candidate.strategyVersion,
    instrumentType: 'DR',
    exitMode: 'FULL_POSITION',
    boardLot: 1,
  });

  assert.equal(intent.exitMode, 'FULL_POSITION');
  assert.equal(intent.instrumentType, 'DR');
  assert.equal(intent.quantity, intent.portfolioQty);
  assert.throws(() => buildIntent({
    ...intent,
    idempotencyKey: 'rc2-dr-wrong-candidate',
    candidateId: 'OTHER',
  }), /FULL_POSITION_EXIT_NOT_ALLOWED/);
});

test('intent is advisory-only and expires', () => {
  const { buildIntent } = require('../netlify/lib/order-intent-store');
  const intent = buildIntent({
    idempotencyKey: 'test-key-2',
    symbol: 'TEST',
    side: 'SELL',
    quantity: 100,
    proposedPrice: 10,
    portfolioQty: 500,
  }, { createdAt: '2026-08-03T01:00:00.000Z', ttlMinutes: 30 });

  assert.equal(intent.modelAuthority, 'ADVISORY_ONLY');
  assert.equal(intent.status, 'PENDING_APPROVAL');
  assert.equal(intent.expiresAt, '2026-08-03T01:30:00.000Z');
});

test('invalid state transition is rejected', () => {
  const { canTransition } = require('../netlify/lib/order-intent-store');
  assert.equal(canTransition('PENDING_APPROVAL', 'SUBMITTED'), false);
  assert.equal(canTransition('PENDING_APPROVAL', 'APPROVING'), true);
});

test('Thai market session gate excludes auctions and lunch', () => {
  const { isThaiContinuousSession } = require('../netlify/lib/approval-executor');
  assert.equal(isThaiContinuousSession(new Date('2026-08-03T02:59:00.000Z')), false);
  assert.equal(isThaiContinuousSession(new Date('2026-08-03T03:10:00.000Z')), true);
  assert.equal(isThaiContinuousSession(new Date('2026-08-03T05:30:00.000Z')), false);
  assert.equal(isThaiContinuousSession(new Date('2026-08-03T07:10:00.000Z')), true);
  assert.equal(isThaiContinuousSession(new Date('2026-08-03T09:25:00.000Z')), false);
});

test('market data gate rejects stale-looking zero quotes and wide spreads', () => {
  const { validateMarketData } = require('../netlify/lib/approval-executor');
  const intent = { side: 'SELL', proposedPrice: 10 };
  assert.throws(() => validateMarketData(intent, { last: 0, bid: 0, ask: 0 }), /QUOTE_NOT_TRADEABLE/);
  assert.throws(() => validateMarketData(intent, { last: 10, bid: 9, ask: 11 }), /SPREAD_TOO_WIDE/);
});

test('market data gate rejects excessive price drift and resting-limit distance', () => {
  const { validateMarketData } = require('../netlify/lib/approval-executor');
  assert.throws(() => validateMarketData(
    { side: 'SELL', proposedPrice: 10, orderStyle: 'MARKETABLE_LIMIT' },
    { last: 10.6, bid: 10.58, ask: 10.6 },
  ), /PRICE_DRIFT_TOO_HIGH/);
  assert.throws(() => validateMarketData(
    { side: 'BUY', proposedPrice: 8, orderStyle: 'RESTING_LIMIT' },
    { last: 10, bid: 9.98, ask: 10 },
  ), /RESTING_LIMIT_TOO_FAR/);
});

test('approval engine is fail-closed by default', () => {
  const { approvalAvailability } = require('../netlify/lib/approval-executor');
  const availability = approvalAvailability();
  assert.equal(availability.ready, false);
  assert.ok(availability.missing.includes('ADMIN_TOKEN'));
});

test('approval readiness uses the SDK gateway and never requires broker secrets in Node', () => {
  Object.assign(process.env, {
    LIVE_TRADING_ENABLED: 'true',
    HUMAN_APPROVAL_LIVE_ENABLED: 'true',
    ADMIN_TOKEN: 'admin-test-token',
    EXECUTE_CONFIRMATION: 'execute-test-token',
    ORDER_INTENT_GATE_SECRET: 'intent-test-secret',
    BROKER_GATEWAY_URL: 'https://broker.example.test',
    BROKER_GATEWAY_TOKEN: 'gateway-test-token',
    BROKER_GATEWAY_ENVIRONMENT: 'prod',
    MAX_LIVE_ORDER_VALUE: '1000',
    MAX_DAILY_APPROVED_NOTIONAL: '1000',
  });
  clear('../netlify/lib/approval-executor');
  const { approvalAvailability } = require('../netlify/lib/approval-executor');
  const availability = approvalAvailability({ releaseManifest: {
    uatOrderCycleComplete: true,
    uatFaultMatrixComplete: true,
    brokerPermissionConfirmed: true,
    productionReadOnlyVerified: true,
    zeroUnresolvedVerified: true,
    strategyReleaseApproved: true,
    executionCompatibilityVerified: true,
    forwardShadowVerified: true,
    privateWorkerEvidence: {
      privateHost: true, gatewayLoopbackOnly: true, persistentJournal: true,
      watchdogEnabled: true, secretsProtected: true, singleSessionFence: true,
      reconciliationEnabled: true, alertsVerified: true, restartDrillPassed: true,
      networkOutageDrillPassed: true, lastVerifiedAt: new Date().toISOString(),
      deployedCommit: 'abc1234', auditedCommit: 'abc1234',
    },
    pilotCapitalEvidence: {
      capital: 10000, price: 1.9, stopPrice: 1.8, boardLot: 100, tickSize: 0.01,
      maxPositionWeight: 0.05, riskPerTradePct: 0.005, cashReserveWeight: 0.2,
      feesVerified: true, protectionVerified: true,
      costModel: {
        commissionRate: 0.0015, setTradingFeeRate: 0.00005,
        clearingFeeRate: 0.00001, regulatoryFeeRate: 0.00001,
        vatRate: 0.07, slippageBpsPerSide: 10, minimumCommissionPerDay: 0,
      },
    },
    deployedCommit: 'abc1234',
    auditedCommit: 'abc1234',
  } });
  assert.equal(availability.ready, true);
  assert.equal(availability.missing.includes('INVX_SECRET'), false);
  assert.equal(availability.gatewayEnvironment, 'prod');
});

test('configured private chat can use operator commands without live approver identity', () => {
  process.env.TELEGRAM_CHAT_ID = '100';
  clear('../netlify/functions/telegram');
  const { _test } = require('../netlify/functions/telegram');

  const update = { message: { from: { id: 201 }, chat: { id: 100, type: 'private' } } };
  assert.equal(_test.isTrustedOperatorChat(update), true);
  assert.equal(_test.isAuthorizedApprover(update), false);
});

test('live approval requires both configured chat and approver user', () => {
  process.env.TELEGRAM_CHAT_ID = '100';
  process.env.TELEGRAM_APPROVER_USER_ID = '200';
  clear('../netlify/functions/telegram');
  const { _test } = require('../netlify/functions/telegram');

  assert.equal(_test.isAuthorizedApprover({
    callback_query: { from: { id: 200 }, message: { chat: { id: 100 } } },
  }), true);

  assert.equal(_test.isAuthorizedApprover({
    callback_query: { from: { id: 201 }, message: { chat: { id: 100 } } },
  }), false);
});

test('order intent signature is deterministic and bound to intent id', () => {
  process.env.ORDER_INTENT_GATE_SECRET = 'test-secret';
  clear('../netlify/functions/invx');
  const { _test } = require('../netlify/functions/invx');
  const a = _test.expectedIntentSignature('0123456789abcdef');
  const b = _test.expectedIntentSignature('0123456789abcdef');
  const c = _test.expectedIntentSignature('fedcba9876543210');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
