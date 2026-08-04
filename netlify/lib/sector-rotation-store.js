const { openBlobStore } = require('./blob-runtime');

const STORE_NAME = 'sector-rotation-v1';
const LATEST_KEY = 'latest/us-sector-rotation.json';

async function getStore(event, consistency = 'eventual') {
  return openBlobStore(STORE_NAME, { event, consistency });
}

async function saveSectorRotation(snapshot, event) {
  if (!snapshot || !Array.isArray(snapshot.sectors)) throw new Error('INVALID_SECTOR_ROTATION_SNAPSHOT');
  const store = await getStore(event, 'prefer-strong');
  await store.set(LATEST_KEY, JSON.stringify(snapshot), {
    metadata: {
      asOf: snapshot.asOf || null,
      generatedAt: snapshot.generatedAt || new Date().toISOString(),
      sectors: snapshot.sectors.length,
      rotationVersion: snapshot.rotationVersion || null,
    },
  });
  return snapshot;
}

async function getLatestSectorRotation(event) {
  const store = await getStore(event, 'eventual');
  return store.get(LATEST_KEY, { type: 'json' });
}

function sectorByTicker(snapshot, ticker) {
  const normalized = String(ticker || '').toUpperCase();
  return (snapshot?.sectors || []).find((item) => item.ticker === normalized) || null;
}

module.exports = {
  saveSectorRotation,
  getLatestSectorRotation,
  sectorByTicker,
  _test: { LATEST_KEY },
};