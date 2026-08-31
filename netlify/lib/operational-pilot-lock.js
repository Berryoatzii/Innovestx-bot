const { openBlobStore } = require('./blob-runtime');

const STORE_NAME = 'operational-pilot-lock-v1';
const LOCK_KEY = 'one-order-pilot.json';

function buildPilotLock(intent, now = new Date()) {
  if (!intent?.id || !intent?.symbol || !intent?.side) throw new Error('PILOT_LOCK_INTENT_INVALID');
  return {
    schemaVersion: 1,
    consumed: true,
    maxOrders: 1,
    intentId: String(intent.id),
    symbol: String(intent.symbol),
    side: String(intent.side),
    reservedAt: now.toISOString(),
    resetAllowed: false,
  };
}

async function reserveWithStore(store, intent, now = new Date()) {
  const lock = buildPilotLock(intent, now);
  try {
    const result = await store.set(LOCK_KEY, JSON.stringify(lock), {
      onlyIfNew: true,
      metadata: { consumed: true, intentId: lock.intentId, reservedAt: lock.reservedAt },
    });
    // Netlify Blobs represents an atomic precondition failure as
    // `{ modified: false }`; it does not throw. Never count that response as a
    // successful reservation, otherwise two different intents could both be
    // reported as accepted even though only the first write won.
    if (result?.modified === false) {
      const existing = await store.get(LOCK_KEY, { type: 'json' });
      if (existing?.consumed === true) {
        throw new Error(`OPERATIONAL_PILOT_ALREADY_CONSUMED:${existing.intentId || 'UNKNOWN'}`);
      }
      throw new Error('OPERATIONAL_PILOT_LOCK_UNCERTAIN:ATOMIC_WRITE_NOT_MODIFIED');
    }
    return lock;
  } catch (error) {
    if (String(error.message || '').startsWith('OPERATIONAL_PILOT_')) throw error;
    const existing = await store.get(LOCK_KEY, { type: 'json' });
    if (existing?.consumed === true) {
      throw new Error(`OPERATIONAL_PILOT_ALREADY_CONSUMED:${existing.intentId || 'UNKNOWN'}`);
    }
    throw new Error(`OPERATIONAL_PILOT_LOCK_UNCERTAIN:${error.message}`);
  }
}

async function reserveOperationalPilotAttempt(intent, event) {
  // Strong consistency is mandatory because this is a lifetime one-order lock,
  // not a daily counter. openBlobStore fails closed if strong reads are unavailable.
  const store = await openBlobStore(STORE_NAME, { event, consistency: 'strong' });
  return reserveWithStore(store, intent);
}

module.exports = {
  STORE_NAME,
  LOCK_KEY,
  buildPilotLock,
  reserveWithStore,
  reserveOperationalPilotAttempt,
};

