const crypto = require('crypto');
const { openBlobStore } = require('./blob-runtime');

const STORE_NAME = 'order-intents-v1';
const INTENT_PREFIX = 'intent/';

async function initializeBlobContext(event) {
  return openBlobStore(STORE_NAME, { event, consistency: 'eventual' });
}

async function getIntentStore(event, consistency = 'eventual') {
  return openBlobStore(STORE_NAME, { event, consistency });
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function normalizeSymbol(symbol) {
  const value = String(symbol || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,20}$/.test(value)) throw new Error('INVALID_SYMBOL');
  return value;
}

function normalizeSide(side) {
  const value = String(side || '').toUpperCase();
  if (value !== 'BUY' && value !== 'SELL') throw new Error('INVALID_SIDE');
  return value;
}

function normalizeOrderStyle(style) {
  const value = String(style || 'MARKETABLE_LIMIT').toUpperCase();
  if (!['MARKETABLE_LIMIT', 'RESTING_LIMIT'].includes(value)) throw new Error('INVALID_ORDER_STYLE');
  return value;
}

function calculateProposalQuantity({
  positionQty,
  price,
  maxFraction = 0.25,
  maxOrderValue = 3000,
  boardLot = 100,
}) {
  const held = Math.floor(Number(positionQty || 0));
  const px = Number(price || 0);
  const fraction = Number(maxFraction || 0);
  const maxValue = Number(maxOrderValue || 0);
  const lot = Math.max(1, Math.floor(Number(boardLot || 100)));

  if (!Number.isFinite(held) || !Number.isFinite(px) || held <= 0 || px <= 0) return 0;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) return 0;
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 0;

  const byFraction = Math.floor((held * fraction) / lot) * lot;
  const byValue = Math.floor((maxValue / px) / lot) * lot;
  const qty = Math.min(byFraction, byValue);

  if (qty < lot || qty >= held) return 0;
  return qty;
}

function calculateBuyProposalQuantity({
  cash,
  price,
  maxOrderValue = 3000,
  cashReserve = 0,
  boardLot = 100,
}) {
  const availableCash = Number(cash || 0);
  const px = Number(price || 0);
  const maxValue = Number(maxOrderValue || 0);
  const reserve = Math.max(0, Number(cashReserve || 0));
  const lot = Math.max(1, Math.floor(Number(boardLot || 100)));
  const spendable = Math.max(0, availableCash - reserve);

  if (![availableCash, px, maxValue].every(Number.isFinite)) return 0;
  if (px <= 0 || maxValue <= 0 || spendable <= 0) return 0;

  const budget = Math.min(spendable, maxValue);
  return Math.floor((budget / px) / lot) * lot;
}

function intentIdFromKey(idempotencyKey) {
  if (!idempotencyKey) throw new Error('MISSING_IDEMPOTENCY_KEY');
  return crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 16);
}

function buildIntent(input, options = {}) {
  const createdAt = options.createdAt || nowIso(options.now || new Date());
  const ttlMinutes = Math.max(5, Math.min(180, Number(options.ttlMinutes || 45)));
  const expiresAt = options.expiresAt || new Date(new Date(createdAt).getTime() + ttlMinutes * 60 * 1000).toISOString();
  const symbol = normalizeSymbol(input.symbol || input.sym);
  const side = normalizeSide(input.side);
  const orderStyle = normalizeOrderStyle(input.orderStyle);
  const quantity = Math.floor(Number(input.quantity || input.qty || 0));
  const proposedPrice = Number(input.proposedPrice || input.price || input.mkt || 0);
  const portfolioQty = Math.max(0, Math.floor(Number(input.portfolioQty || input.positionQty || 0)));
  const id = intentIdFromKey(input.idempotencyKey);

  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('INVALID_QUANTITY');
  if (!Number.isFinite(proposedPrice) || proposedPrice <= 0) throw new Error('INVALID_PRICE');
  if (!Number.isFinite(portfolioQty) || portfolioQty < 0) throw new Error('INVALID_PORTFOLIO_QUANTITY');
  if (side === 'SELL' && portfolioQty <= quantity) throw new Error('FULL_POSITION_EXIT_NOT_ALLOWED');

  return {
    schemaVersion: 3,
    id,
    idempotencyKey: String(input.idempotencyKey),
    status: 'PENDING_APPROVAL',
    symbol,
    side,
    orderStyle,
    quantity,
    proposedPrice,
    estimatedValue: Number((quantity * proposedPrice).toFixed(2)),
    portfolioQty,
    portfolioBucket: input.portfolioBucket || 'REVIEW',
    strategyVersion: input.strategyVersion || 'RULES_PROPOSAL_V1',
    runId: input.runId || null,
    reasonCode: input.reasonCode || 'RULES_SIGNAL',
    reason: String(input.reason || '').slice(0, 1000),
    modelAuthority: input.modelAuthority || 'ADVISORY_ONLY',
    decisionAuthority: input.decisionAuthority || 'DETERMINISTIC_RULES_PLUS_HUMAN_APPROVAL',
    source: input.source || 'rules-proposal',
    createdAt,
    expiresAt,
    updatedAt: createdAt,
    approval: null,
    broker: null,
    audit: [{ at: createdAt, event: 'INTENT_CREATED', actor: 'system' }],
  };
}

function intentKey(id) {
  const value = String(id || '').toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(value)) throw new Error('INVALID_INTENT_ID');
  return `${INTENT_PREFIX}${value}.json`;
}

async function createIntent(input, options = {}) {
  const intent = buildIntent(input, options);
  const key = intentKey(intent.id);
  const store = await getIntentStore(options.event, 'prefer-strong');
  try {
    await store.set(key, JSON.stringify(intent), {
      onlyIfNew: true,
      metadata: { status: intent.status, symbol: intent.symbol, createdAt: intent.createdAt },
    });
    return { intent, created: true };
  } catch (error) {
    const existing = await store.get(key, { type: 'json' });
    if (existing) return { intent: existing, created: false };
    throw error;
  }
}

async function getIntentWithMetadata(id, event, options = {}) {
  const consistency = options.requireStrong === true ? 'strong' : 'eventual';
  const store = await getIntentStore(event, consistency);
  const record = await store.getWithMetadata(intentKey(id), { type: 'json' });
  if (!record) return null;
  return { ...record, key: intentKey(id), store };
}

async function getIntent(id, event, options = {}) {
  const record = await getIntentWithMetadata(id, event, options);
  return record ? record.data : null;
}

const ALLOWED_TRANSITIONS = {
  PENDING_APPROVAL: new Set(['APPROVING', 'REJECTED', 'EXPIRED']),
  APPROVING: new Set(['PENDING_APPROVAL', 'FAILED_PRECHECK', 'SUBMITTED', 'EXECUTION_UNCERTAIN']),
  SUBMITTED: new Set(['ACKNOWLEDGED', 'RECONCILE_PENDING', 'EXECUTION_UNCERTAIN']),
  RECONCILE_PENDING: new Set(['ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED_BY_BROKER', 'CANCELLED', 'EXECUTION_UNCERTAIN']),
  ACKNOWLEDGED: new Set(['RECONCILE_PENDING', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED_BY_BROKER', 'CANCELLED', 'EXECUTION_UNCERTAIN']),
  PARTIALLY_FILLED: new Set(['RECONCILE_PENDING', 'FILLED', 'CANCELLED', 'REJECTED_BY_BROKER', 'EXECUTION_UNCERTAIN']),
};

function canTransition(from, to) {
  return Boolean(ALLOWED_TRANSITIONS[from]?.has(to));
}

async function transitionIntent(id, expectedStatuses, nextStatus, patch = {}, options = {}) {
  const expected = new Set(Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses]);
  const record = await getIntentWithMetadata(id, options.event, { requireStrong: true });
  if (!record) throw new Error('INTENT_NOT_FOUND');
  const current = record.data;

  if (!expected.has(current.status)) throw new Error(`INTENT_STATE_CONFLICT:${current.status}`);
  if (!canTransition(current.status, nextStatus)) throw new Error(`INVALID_TRANSITION:${current.status}->${nextStatus}`);
  if (!record.etag) throw new Error('MISSING_INTENT_ETAG');

  const at = options.at || nowIso();
  const next = {
    ...current,
    ...patch,
    status: nextStatus,
    updatedAt: at,
    audit: [
      ...(Array.isArray(current.audit) ? current.audit : []),
      {
        at,
        event: `STATUS_${nextStatus}`,
        actor: options.actor || 'system',
        note: options.note || null,
      },
    ],
  };

  try {
    await record.store.set(record.key, JSON.stringify(next), {
      onlyIfMatch: record.etag,
      metadata: { status: next.status, symbol: next.symbol, updatedAt: next.updatedAt },
    });
  } catch (error) {
    throw new Error(`INTENT_CONCURRENT_UPDATE:${error.message}`);
  }
  return next;
}

async function listIntents(event, { status, limit = 200 } = {}) {
  const store = await getIntentStore(event, 'eventual');
  const { blobs } = await store.list({ prefix: INTENT_PREFIX });
  const selected = blobs.slice(-Math.max(1, Math.min(1000, limit)));
  const rows = [];
  for (const blob of selected) {
    const item = await store.get(blob.key, { type: 'json' });
    if (!item) continue;
    if (status && item.status !== status) continue;
    rows.push(item);
  }
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getDailyExecutionStats(event, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const intents = await listIntents(event, { limit: 1000 });
  const executedStatuses = new Set(['SUBMITTED', 'ACKNOWLEDGED', 'RECONCILE_PENDING', 'PARTIALLY_FILLED', 'FILLED']);
  const matched = intents.filter((intent) => String(intent.createdAt || '').startsWith(day) && executedStatuses.has(intent.status));
  return {
    date: day,
    count: matched.length,
    notional: Number(matched.reduce((sum, item) => sum + Number(item.broker?.submittedValue || item.estimatedValue || 0), 0).toFixed(2)),
  };
}

function isExpired(intent, now = new Date()) {
  const expiry = new Date(intent?.expiresAt || 0).getTime();
  return !Number.isFinite(expiry) || expiry <= now.getTime();
}

module.exports = {
  initializeBlobContext,
  calculateProposalQuantity,
  calculateBuyProposalQuantity,
  buildIntent,
  createIntent,
  getIntent,
  getIntentWithMetadata,
  transitionIntent,
  listIntents,
  getDailyExecutionStats,
  isExpired,
  canTransition,
  _test: { normalizeSymbol, normalizeSide, normalizeOrderStyle, intentIdFromKey, intentKey },
};