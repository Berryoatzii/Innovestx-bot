const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOCK_KEY,
  buildPilotLock,
  reserveWithStore,
} = require('../netlify/lib/operational-pilot-lock');

function atomicMemoryStore() {
  let value = null;
  return {
    async set(key, body, options) {
      assert.equal(key, LOCK_KEY);
      assert.equal(options.onlyIfNew, true);
      if (value !== null) return { modified: false };
      value = JSON.parse(body);
      return { modified: true, etag: 'memory-etag' };
    },
    async get(key) {
      assert.equal(key, LOCK_KEY);
      return value;
    },
  };
}

const intent = { id: 'abcdef0123456789', symbol: 'TTB', side: 'BUY' };

test('operational pilot lock is permanent and bound to one intent', () => {
  const lock = buildPilotLock(intent, new Date('2026-08-26T08:00:00Z'));
  assert.equal(lock.consumed, true);
  assert.equal(lock.maxOrders, 1);
  assert.equal(lock.intentId, intent.id);
  assert.equal(lock.resetAllowed, false);
});

test('only the first operational pilot reservation succeeds', async () => {
  const store = atomicMemoryStore();
  const first = await reserveWithStore(store, intent, new Date('2026-08-26T08:00:00Z'));
  assert.equal(first.intentId, intent.id);
  await assert.rejects(
    () => reserveWithStore(store, { ...intent, id: '1111111111111111' }),
    /OPERATIONAL_PILOT_ALREADY_CONSUMED:abcdef0123456789/,
  );
});

test('unknown lock-write outcome fails closed', async () => {
  const store = {
    async set() { throw new Error('NETWORK_TIMEOUT'); },
    async get() { return null; },
  };
  await assert.rejects(
    () => reserveWithStore(store, intent),
    /OPERATIONAL_PILOT_LOCK_UNCERTAIN:NETWORK_TIMEOUT/,
  );
});

test('atomic not-modified response can never be reported as a reservation', async () => {
  const store = {
    async set() { return { modified: false }; },
    async get() { return null; },
  };
  await assert.rejects(
    () => reserveWithStore(store, intent),
    /OPERATIONAL_PILOT_LOCK_UNCERTAIN:ATOMIC_WRITE_NOT_MODIFIED/,
  );
});

