const STORE_NAME = 'fundamental-snapshots-v1';
const PREFIX = 'snapshot/';
let blobsPromise = null;
let connected = false;

function loadBlobs() {
  if (!blobsPromise) blobsPromise = import('@netlify/blobs');
  return blobsPromise;
}

async function connect(event) {
  if (connected) return;
  const mod = await loadBlobs();
  if (typeof mod.connectLambda === 'function' && event) {
    try { mod.connectLambda(event); }
    catch (error) { console.warn('[fundamental-store] connectLambda skipped:', error.message); }
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
  if (!/^[A-Z0-9._-]{1,20}$/.test(value)) throw new Error('INVALID_FUNDAMENTAL_SYMBOL');
  return value;
}

function keyFor(symbol) {
  return `${PREFIX}${normalizeSymbol(symbol)}.json`;
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAnnual(row) {
  return {
    year: Number(row.year),
    revenue: finiteOrNull(row.revenue),
    netIncome: finiteOrNull(row.netIncome),
    eps: finiteOrNull(row.eps),
    roePct: finiteOrNull(row.roePct),
    roaPct: finiteOrNull(row.roaPct),
    debtToEquity: finiteOrNull(row.debtToEquity),
    interestCoverage: finiteOrNull(row.interestCoverage),
    operatingCashFlow: finiteOrNull(row.operatingCashFlow),
    freeCashFlow: finiteOrNull(row.freeCashFlow),
    retainedEarnings: finiteOrNull(row.retainedEarnings),
    dividendPerShare: finiteOrNull(row.dividendPerShare),
    payoutRatioPct: finiteOrNull(row.payoutRatioPct),
  };
}

function normalizeSnapshot(input, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const source = Array.isArray(input.source)
    ? input.source.map((item) => String(item).slice(0, 300))
    : [String(input.source || 'UNVERIFIED')];
  const snapshot = {
    schemaVersion: 1,
    symbol: normalizeSymbol(input.symbol),
    sectorProfile: String(input.sectorProfile || 'GENERAL').toUpperCase(),
    asOf: String(input.asOf || now.toISOString().slice(0, 10)),
    fetchedAt: input.fetchedAt || now.toISOString(),
    verifiedAt: input.verifiedAt || null,
    verifiedBy: input.verifiedBy || null,
    source,
    sourceUrls: Array.isArray(input.sourceUrls) ? input.sourceUrls.slice(0, 20) : [],
    businessType: String(input.businessType || '').slice(0, 5000),
    auditOpinion: String(input.auditOpinion || '').slice(0, 500),
    market: {
      price: finiteOrNull(input.market?.price),
      pe: finiteOrNull(input.market?.pe),
      pbv: finiteOrNull(input.market?.pbv),
      evEbitda: finiteOrNull(input.market?.evEbitda),
      dividendYieldPct: finiteOrNull(input.market?.dividendYieldPct),
      ownMedianPe: finiteOrNull(input.market?.ownMedianPe),
      sectorMedianPe: finiteOrNull(input.market?.sectorMedianPe),
      fairValueLow: finiteOrNull(input.market?.fairValueLow),
      fairValueHigh: finiteOrNull(input.market?.fairValueHigh),
    },
    annuals: (Array.isArray(input.annuals) ? input.annuals : [])
      .map(normalizeAnnual)
      .filter((row) => Number.isInteger(row.year))
      .sort((a, b) => a.year - b.year)
      .slice(-5),
    latestQuarter: input.latestQuarter || null,
    consecutiveWeakQuarters: Math.max(0, Number(input.consecutiveWeakQuarters || 0)),
    dividendChangePct: finiteOrNull(input.dividendChangePct),
    auditorOpinionChanged: input.auditorOpinionChanged === true,
    moatLost: input.moatLost === true,
    materialDisruption: input.materialDisruption === true,
    governanceRedFlag: input.governanceRedFlag === true,
    manualEvidence: input.manualEvidence && typeof input.manualEvidence === 'object' ? input.manualEvidence : {},
    rawOfficial: input.rawOfficial || null,
    completeness: null,
    updatedAt: now.toISOString(),
  };

  const requirements = {
    marketPe: snapshot.market.pe != null,
    dividendYield: snapshot.market.dividendYieldPct != null,
    annuals3: snapshot.annuals.length >= 3,
    auditOpinion: Boolean(snapshot.auditOpinion),
    sectorProfile: Boolean(snapshot.sectorProfile),
    verified: Boolean(snapshot.verifiedAt && snapshot.verifiedBy),
  };
  snapshot.completeness = {
    ...requirements,
    ratio: Object.values(requirements).filter(Boolean).length / Object.keys(requirements).length,
  };
  return snapshot;
}

function snapshotFreshness(snapshot, policy, now = new Date()) {
  if (!snapshot) return { fresh: false, reason: 'SNAPSHOT_MISSING' };
  const asOfMs = new Date(`${snapshot.asOf}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(asOfMs)) return { fresh: false, reason: 'SNAPSHOT_DATE_INVALID' };
  const ageDays = (now.getTime() - asOfMs) / 86400000;
  const maximumDays = Number(policy?.freshnessDays?.quarterlyFinancials || 140);
  if (ageDays > maximumDays) return { fresh: false, reason: 'SNAPSHOT_STALE', ageDays, maximumDays };
  if (!snapshot.verifiedAt || !snapshot.verifiedBy) return { fresh: false, reason: 'SNAPSHOT_NOT_VERIFIED' };
  if (Number(snapshot.completeness?.ratio || 0) < 1) return { fresh: false, reason: 'SNAPSHOT_INCOMPLETE' };
  return { fresh: true, reason: 'SNAPSHOT_FRESH', ageDays, maximumDays };
}

async function putSnapshot(input, event) {
  const snapshot = normalizeSnapshot(input);
  const store = await getStore(event);
  await store.set(keyFor(snapshot.symbol), JSON.stringify(snapshot), {
    metadata: {
      symbol: snapshot.symbol,
      asOf: snapshot.asOf,
      verified: Boolean(snapshot.verifiedAt),
      updatedAt: snapshot.updatedAt,
    },
  });
  return snapshot;
}

async function getSnapshot(symbol, event) {
  const store = await getStore(event);
  return store.get(keyFor(symbol), { type: 'json', consistency: 'strong' });
}

async function listSnapshots(event) {
  const store = await getStore(event);
  const { blobs } = await store.list({ prefix: PREFIX });
  const snapshots = [];
  for (const blob of blobs) {
    const snapshot = await store.get(blob.key, { type: 'json', consistency: 'strong' });
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

module.exports = {
  normalizeSnapshot,
  snapshotFreshness,
  putSnapshot,
  getSnapshot,
  listSnapshots,
  _test: { normalizeSymbol, keyFor, finiteOrNull, normalizeAnnual },
};
