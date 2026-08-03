const seed = require('../../config/research-seed-coach-ou-2025.json');

const STORE_NAME = 'portfolio-operator-v1';
const PREFIX = 'classification/';
const SNAPSHOT_KEY = 'snapshot/latest-portfolio.json';
let modulePromise = null;
let connected = false;

function loadBlobs() {
  if (!modulePromise) modulePromise = import('@netlify/blobs');
  return modulePromise;
}

async function connect(event) {
  if (connected) return;
  const mod = await loadBlobs();
  if (typeof mod.connectLambda === 'function' && event) {
    try { mod.connectLambda(event); }
    catch (error) { console.warn('[classification-store] connectLambda skipped:', error.message); }
  }
  connected = true;
}

async function getStore(event) {
  await connect(event);
  const { getStore } = await loadBlobs();
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function normalizeSymbol(symbol) {
  const value = String(symbol || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,20}$/.test(value)) throw new Error('INVALID_SYMBOL');
  return value;
}

function normalizeBucket(bucket) {
  const value = String(bucket || '').toUpperCase().trim();
  if (!['CORE', 'ACTIVE', 'REVIEW'].includes(value)) throw new Error('INVALID_BUCKET');
  return value;
}

function keyFor(symbol) {
  return `${PREFIX}${normalizeSymbol(symbol)}.json`;
}

function suggestBucket(symbol) {
  const normalized = normalizeSymbol(symbol);
  if ((seed.suggestions?.CORE || []).includes(normalized)) {
    return { bucket: 'CORE', source: seed.sourceType, sourceDate: seed.sourceDate };
  }
  if ((seed.suggestions?.ACTIVE || []).includes(normalized)) {
    return { bucket: 'ACTIVE', source: seed.sourceType, sourceDate: seed.sourceDate };
  }
  return { bucket: 'REVIEW', source: 'NO_HISTORICAL_SUGGESTION', sourceDate: null };
}

async function getClassification(symbol, event) {
  const store = await getStore(event);
  return store.get(keyFor(symbol), { type: 'json', consistency: 'strong' });
}

async function setClassification(symbol, bucket, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedBucket = normalizeBucket(bucket);
  const store = await getStore(options.event);
  const key = keyFor(normalizedSymbol);
  const current = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  const now = options.at || new Date().toISOString();
  const suggestion = suggestBucket(normalizedSymbol);
  const next = {
    schemaVersion: 1,
    symbol: normalizedSymbol,
    bucket: normalizedBucket,
    explicit: true,
    suggestedBucket: suggestion.bucket,
    suggestionSource: suggestion.source,
    suggestionSourceDate: suggestion.sourceDate,
    approvedBy: options.actor || 'operator',
    approvedAt: current?.data?.approvedAt || now,
    updatedAt: now,
    note: options.note || null,
    history: [
      ...(Array.isArray(current?.data?.history) ? current.data.history : []),
      {
        at: now,
        from: current?.data?.bucket || null,
        to: normalizedBucket,
        actor: options.actor || 'operator',
        note: options.note || null,
      },
    ],
  };

  const writeOptions = {
    metadata: { symbol: normalizedSymbol, bucket: normalizedBucket, updatedAt: now },
  };
  if (current?.etag) writeOptions.onlyIfMatch = current.etag;
  else writeOptions.onlyIfNew = true;

  try {
    await store.set(key, JSON.stringify(next), writeOptions);
  } catch (error) {
    throw new Error(`CLASSIFICATION_CONFLICT:${error.message}`);
  }
  return next;
}

async function listClassifications(event) {
  const store = await getStore(event);
  const { blobs } = await store.list({ prefix: PREFIX });
  const rows = [];
  for (const blob of blobs) {
    const item = await store.get(blob.key, { type: 'json', consistency: 'strong' });
    if (item) rows.push(item);
  }
  return rows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function classificationMap(event) {
  const rows = await listClassifications(event);
  return Object.fromEntries(rows.map((item) => [item.symbol, item]));
}

async function savePortfolioSnapshot(portfolio, cash, event) {
  const store = await getStore(event);
  const payload = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    cash: Number(cash || 0),
    positions: (Array.isArray(portfolio) ? portfolio : []).map((item) => ({
      symbol: normalizeSymbol(item.sym || item.symbol),
      quantity: Number(item.qty || item.quantity || 0),
      price: Number(item.mkt || item.marketPrice || item.last || 0),
      averageCost: Number(item.avg || item.averagePrice || item.avgCost || 0),
    })),
  };
  await store.set(SNAPSHOT_KEY, JSON.stringify(payload), {
    metadata: { recordedAt: payload.recordedAt, positions: payload.positions.length },
  });
  return payload;
}

async function getPortfolioSnapshot(event) {
  const store = await getStore(event);
  return store.get(SNAPSHOT_KEY, { type: 'json', consistency: 'strong' });
}

function summarizeClassifications(portfolio, map) {
  const rows = (Array.isArray(portfolio) ? portfolio : []).map((item) => {
    const symbol = normalizeSymbol(item.sym || item.symbol);
    const explicit = map?.[symbol] || null;
    const suggestion = suggestBucket(symbol);
    return {
      symbol,
      bucket: explicit?.bucket || 'REVIEW',
      explicit: Boolean(explicit?.explicit),
      suggestedBucket: suggestion.bucket,
    };
  });
  const counts = { CORE: 0, ACTIVE: 0, REVIEW: 0, UNCLASSIFIED: 0 };
  for (const row of rows) {
    counts[row.bucket] += 1;
    if (!row.explicit) counts.UNCLASSIFIED += 1;
  }
  return { rows, counts, complete: counts.UNCLASSIFIED === 0 };
}

module.exports = {
  connect,
  normalizeSymbol,
  normalizeBucket,
  suggestBucket,
  getClassification,
  setClassification,
  listClassifications,
  classificationMap,
  savePortfolioSnapshot,
  getPortfolioSnapshot,
  summarizeClassifications,
};
