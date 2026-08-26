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
    await store.set(LOCK_KEY, JSON.stringify(lock), {
      onlyIfNew: true,
      metadata: { consumed: true, intentId: lock.intentId, reservedAt: lock.reservedAt },
    });
    return lock;
  } catch (error) {
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
