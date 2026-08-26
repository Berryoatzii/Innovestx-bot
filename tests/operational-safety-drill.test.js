const test = require('node:test');
const assert = require('node:assert/strict');

const {
  exerciseOneOrderLock,
  buildSafetyEvidence,
} = require('../netlify/lib/operational-safety-drill');

function atomicMemoryStore() {
  let value = null;
  return {
    async set(_key, body, options) {
      if (options.onlyIfNew && value !== null) throw new Error('PRECONDITION_FAILED');
      value = JSON.parse(body);
    },
    async get() { return value; },
  };
}

test('safety drill proves first reservation and blocks the second', async () => {
  const result = await exerciseOneOrderLock(
    atomicMemoryStore(),
    new Date('2026-08-26T10:00:00Z'),
  );
  assert.deepEqual(result, {
    firstReservationVerified: true,
    secondReservationBlocked: true,
  });
});

test('safety drill evidence cannot imply a broker call or money movement', () => {
  const evidence = buildSafetyEvidence({
    firstReservationVerified: true,
    secondReservationBlocked: true,
  }, new Date('2026-08-26T10:00:00Z'));
  assert.equal(evidence.passed, true);
  assert.equal(evidence.approvalCallbackVerified, true);
  assert.equal(evidence.alertDelivered, true);
  assert.equal(evidence.brokerCalled, false);
  assert.equal(evidence.orderIntentCreated, false);
  assert.equal(evidence.moneyMoving, false);
});
