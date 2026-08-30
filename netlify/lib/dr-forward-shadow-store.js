const { openBlobStore } = require('./blob-runtime');
const {
  createLedger,
  appendObservation,
  verifyLedgerIntegrity,
} = require('./dr-forward-shadow');

const STORE_NAME = 'dr-forward-shadow-rc2-v1';
const LEDGER_KEY = 'ledger.json';

async function getStore(event, consistency = 'strong') {
  return openBlobStore(STORE_NAME, { event, consistency });
}

async function getForwardShadowLedger(event, consistency = 'strong') {
  const store = await getStore(event, consistency);
  const record = await store.getWithMetadata(LEDGER_KEY, { type: 'json' });
  if (!record) return { ledger: createLedger(), etag: null, store };
  if (!verifyLedgerIntegrity(record.data)) throw new Error('FORWARD_SHADOW_LEDGER_INTEGRITY_FAILED');
  return { ledger: record.data, etag: record.etag || null, store };
}

async function appendForwardShadowObservation(observation, event) {
  const current = await getForwardShadowLedger(event, 'strong');
  const appended = appendObservation(current.ledger, observation);
  if (!appended.created) return { ...appended, persisted: false };
  const options = {
    metadata: {
      updatedAt: new Date().toISOString(),
      tradingDays: appended.ledger.tradingDays,
      rebalanceEvents: appended.ledger.rebalanceEvents,
      passed: appended.ledger.passed,
    },
  };
  if (current.etag) options.onlyIfMatch = current.etag;
  else options.onlyIfNew = true;
  try {
    await current.store.set(LEDGER_KEY, JSON.stringify(appended.ledger), options);
  } catch (error) {
    throw new Error(`FORWARD_SHADOW_LEDGER_CONFLICT:${error.message}`);
  }
  return { ...appended, persisted: true };
}

module.exports = {
  getForwardShadowLedger,
  appendForwardShadowObservation,
  _test: { STORE_NAME, LEDGER_KEY },
};
