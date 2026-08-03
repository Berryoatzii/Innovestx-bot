const test = require('node:test');
const assert = require('node:assert/strict');

function clear(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; } catch {}
}

test('manual draft validates board lot, tick size and order value', () => {
  const { validateDraftInput } = require('../netlify/lib/manual-order-draft');

  const valid = validateDraftInput({
    side: 'SELL', symbol: 'ICN', quantity: 300, price: 2.24,
  }, { boardLot: 100, maxOrderValue: 3000 });
  assert.equal(valid.quantity, 300);
  assert.equal(valid.price, 2.24);
  assert.equal(valid.estimatedValue, 672);

  assert.throws(() => validateDraftInput({
    side: 'SELL', symbol: 'ICN', quantity: 150, price: 2.24,
  }, { boardLot: 100, maxOrderValue: 3000 }), /ล็อตละ 100/);

  assert.throws(() => validateDraftInput({
    side: 'BUY', symbol: 'AIT', quantity: 100, price: 4.91,
  }, { boardLot: 100, maxOrderValue: 3000 }), /Tick Size/);

  assert.throws(() => validateDraftInput({
    side: 'BUY', symbol: 'AIT', quantity: 1000, price: 4.90,
  }, { boardLot: 100, maxOrderValue: 3000 }), /เกินวงเงิน/);
});

test('order intent stores resting-limit style and manual authority', () => {
  const { buildIntent } = require('../netlify/lib/order-intent-store');
  const intent = buildIntent({
    idempotencyKey: 'manual-limit-test',
    symbol: 'ICN',
    side: 'SELL',
    quantity: 300,
    proposedPrice: 2.24,
    portfolioQty: 1500,
    portfolioBucket: 'ACTIVE',
    orderStyle: 'RESTING_LIMIT',
    modelAuthority: 'NONE',
    decisionAuthority: 'HUMAN_OPERATOR_LIMIT_DRAFT_PLUS_RISK_APPROVAL',
  });

  assert.equal(intent.orderStyle, 'RESTING_LIMIT');
  assert.equal(intent.modelAuthority, 'NONE');
  assert.equal(intent.decisionAuthority, 'HUMAN_OPERATOR_LIMIT_DRAFT_PLUS_RISK_APPROVAL');
});

test('resting-limit preflight preserves requested price within distance limit', () => {
  delete process.env.MAX_RESTING_LIMIT_DISTANCE_PCT;
  const { validateMarketData } = require('../netlify/lib/approval-executor');
  const market = validateMarketData({
    side: 'SELL', orderStyle: 'RESTING_LIMIT', proposedPrice: 11,
  }, { last: 10, bid: 9.9, ask: 10.1 });

  assert.equal(market.executionPrice, 11);
  assert.equal(market.orderStyle, 'RESTING_LIMIT');

  assert.throws(() => validateMarketData({
    side: 'SELL', orderStyle: 'RESTING_LIMIT', proposedPrice: 12,
  }, { last: 10, bid: 9.9, ask: 10.1 }), /RESTING_LIMIT_TOO_FAR/);
});

test('Thai menu exposes understandable commands and examples', () => {
  process.env.TELEGRAM_CHAT_ID = '100';
  clear('../netlify/functions/telegram');
  const { _test } = require('../netlify/functions/telegram');
  const commands = _test.commandDefinitions();
  const names = commands.map((item) => item.command);

  assert.ok(names.includes('menu'));
  assert.ok(names.includes('plan'));
  assert.ok(names.includes('buy'));
  assert.ok(names.includes('sell'));
  assert.ok(names.includes('orders'));
  assert.match(_test.menuText(), /\/sell ICN 300 2\.24/);
  assert.deepEqual(_test.parseManualCommand('/buy AIT 100 4.90', 'BUY'), {
    side: 'BUY', symbol: 'AIT', quantity: 100, price: 4.9,
  });
});

test('broker gateway allows manual authority but keeps signed binding', () => {
  clear('../netlify/functions/invx');
  const { _test } = require('../netlify/functions/invx');
  assert.equal(
    _test.ALLOWED_DECISION_AUTHORITIES.has('HUMAN_OPERATOR_LIMIT_DRAFT_PLUS_RISK_APPROVAL'),
    true
  );
});