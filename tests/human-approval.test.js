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

test('approval engine is fail-closed by default', () => {
  const { approvalAvailability } = require('../netlify/lib/approval-executor');
  const availability = approvalAvailability();
  assert.equal(availability.ready, false);
  assert.ok(availability.missing.includes('ADMIN_TOKEN'));
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