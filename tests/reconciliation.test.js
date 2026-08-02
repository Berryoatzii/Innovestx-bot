const test = require('node:test');
const assert = require('node:assert/strict');

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
