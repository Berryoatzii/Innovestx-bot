const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateDailyExecutionStats } = require('../netlify/lib/order-intent-store');

test('raw Settrade order normalization preserves side and order ID', () => {
  const { normalizeRawOrders } = require('../netlify/lib/settrade-read');
  const rows = normalizeRawOrders({
    orderList: [
      { orderId: 'A1', symbol: 'TCAP', side: 'Buy', status: 'Pending', volume: 100 },
      { orderNo: 'A2', symbol: 'PM', side: 'S', status: 'Filled', volume: 200, matchedVolume: 200 },
    ],
  });

  assert.deepEqual(rows.map((row) => [row.id, row.side, row.status]), [
    ['A1', 'BUY', 'PENDING'],
    ['A2', 'SELL', 'FILLED'],
  ]);
});

test('intent state machine permits partial fill to complete later', () => {
  const { canTransition } = require('../netlify/lib/order-intent-store');
  assert.equal(canTransition('APPROVING', 'SUBMITTING'), true);
  assert.equal(canTransition('SUBMITTING', 'SUBMITTED'), true);
  assert.equal(canTransition('SUBMITTING', 'EXECUTION_UNCERTAIN'), true);
  assert.equal(canTransition('PARTIALLY_FILLED', 'FILLED'), true);
  assert.equal(canTransition('ACKNOWLEDGED', 'RECONCILE_PENDING'), true);
  assert.equal(canTransition('FILLED', 'SUBMITTED'), false);
});

test('reconciliation maps broker states without creating orders', () => {
  const { _test } = require('../netlify/functions/reconcile-orders');
  assert.equal(_test.brokerStatusToIntentStatus('Partially Matched'), 'PARTIALLY_FILLED');
  assert.equal(_test.brokerStatusToIntentStatus('Filled'), 'FILLED');
  assert.equal(_test.brokerStatusToIntentStatus('Rejected'), 'REJECTED_BY_BROKER');
  assert.equal(_test.brokerStatusToIntentStatus('Cancelled'), 'CANCELLED');
  assert.equal(_test.brokerStatusToIntentStatus('Pending'), 'ACKNOWLEDGED');
});

test('Settrade V2 equity fields and official short status codes are normalized', () => {
  const { normalizeRawOrders } = require('../netlify/lib/settrade-read');
  const { normalizeBrokerOrderState, isBrokerOrderTerminal } = require('../netlify/lib/broker-order-status');
  const [partial] = normalizeRawOrders([{
    orderNo: 'V2-1', symbol: 'AOT', side: 'Buy', status: 'MP',
    vol: 100, matched: 40, entryTime: '2026-08-05T10:15:00+07:00',
  }]);

  assert.equal(partial.quantity, 100);
  assert.equal(partial.matchedQuantity, 40);
  assert.equal(partial.entryTime, '2026-08-05T10:15:00+07:00');
  assert.equal(normalizeBrokerOrderState(partial), 'PARTIALLY_FILLED');
  assert.equal(normalizeBrokerOrderState({ status: 'M', vol: 100, matched: 100 }), 'FILLED');
  assert.equal(normalizeBrokerOrderState('SX'), 'ACKNOWLEDGED');
  assert.equal(normalizeBrokerOrderState('E'), 'EXECUTION_UNCERTAIN');
  assert.equal(normalizeBrokerOrderState('UNKNOWN'), 'EXECUTION_UNCERTAIN');
  assert.equal(normalizeBrokerOrderState({ status: 'Cancelled', vol: 100, matched: 40 }), 'CANCELLED');
  assert.equal(isBrokerOrderTerminal('M'), true);
  assert.equal(isBrokerOrderTerminal('MP'), false);
});

test('daily risk gate reserves uncertain and concurrent approvals', () => {
  const date = new Date('2026-08-05T03:00:00.000Z');
  const intents = [
    { id: 'a', createdAt: '2026-08-05T02:00:00.000Z', status: 'EXECUTION_UNCERTAIN', estimatedValue: 2500 },
    { id: 'b', createdAt: '2026-08-05T02:01:00.000Z', status: 'APPROVING', estimatedValue: 1500 },
    { id: 'c', createdAt: '2026-08-05T02:02:00.000Z', status: 'FAILED_PRECHECK', estimatedValue: 9000 },
    { id: 'd', createdAt: '2026-08-05T02:03:00.000Z', status: 'SUBMITTING', estimatedValue: 500 },
  ];

  assert.deepEqual(calculateDailyExecutionStats(intents, date), {
    date: '2026-08-05',
    count: 3,
    notional: 4500,
  });
  assert.deepEqual(calculateDailyExecutionStats(intents, date, { excludeIntentId: 'b' }), {
    date: '2026-08-05',
    count: 2,
    notional: 3000,
  });
});

test('uncertain execution recovers only from one exact time-bounded broker order', () => {
  const { _test } = require('../netlify/functions/reconcile-orders');
  const intent = {
    symbol: 'AOT', side: 'BUY', quantity: 100, proposedPrice: 40,
    broker: { submittedAt: '2026-08-05T03:15:20.000Z', request: { price: 40 } },
  };
  const exact = {
    id: '9001', symbol: 'AOT', side: 'BUY', quantity: 100, price: 40,
    entryTime: '2026-08-05T03:15:00.000Z', status: 'SX',
  };

  assert.equal(_test.findUniqueUncertainOrder(intent, [exact])?.id, '9001');
  assert.equal(_test.findUniqueUncertainOrder(intent, [exact], new Set(['9001'])), null);
  assert.equal(_test.findUniqueUncertainOrder(intent, [exact, { ...exact, id: '9002' }]), null);
  assert.equal(_test.findUniqueUncertainOrder(intent, [{ ...exact, entryTime: '2026-08-05T02:00:00.000Z' }]), null);
});
