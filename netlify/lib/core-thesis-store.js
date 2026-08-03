const { openBlobStore } = require('./blob-runtime');

const STORE_NAME = 'core-thesis-v1';
const PREFIX = 'thesis/';

async function getStore(event, consistency = 'eventual') {
  return openBlobStore(STORE_NAME, { event, consistency });
}

function normalizeSymbol(symbol) {
  const value = String(symbol || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,20}$/.test(value)) throw new Error('INVALID_THESIS_SYMBOL');
  return value;
}

function keyFor(symbol) {
  return `${PREFIX}${normalizeSymbol(symbol)}.json`;
}

function text(value, max = 3000) {
  return String(value || '').trim().slice(0, max);
}

function arrayOfText(value, maxItems = 20, maxLength = 500) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(0, maxItems).map((item) => text(item, maxLength)).filter(Boolean);
}

function buildThesisCard(input, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const approvedAt = input.status === 'APPROVED'
    ? (input.approvedAt || now.toISOString())
    : null;
  const reviewDays = Math.max(30, Math.min(365, Number(input.reviewDays || 180)));
  const reviewDueAt = approvedAt
    ? (input.reviewDueAt || new Date(new Date(approvedAt).getTime() + reviewDays * 86400000).toISOString())
    : null;

  const card = {
    schemaVersion: 1,
    symbol: normalizeSymbol(input.symbol),
    status: ['DRAFT', 'APPROVED', 'REJECTED'].includes(input.status) ? input.status : 'DRAFT',
    businessModel: text(input.businessModel),
    revenueDrivers: arrayOfText(input.revenueDrivers),
    moatType: arrayOfText(input.moatType),
    moatEvidence: arrayOfText(input.moatEvidence),
    pricingPowerEvidence: arrayOfText(input.pricingPowerEvidence),
    competitors: arrayOfText(input.competitors),
    disruptionRisks: arrayOfText(input.disruptionRisks),
    demandOutlook: text(input.demandOutlook),
    regulationRisks: arrayOfText(input.regulationRisks),
    governanceRisks: arrayOfText(input.governanceRisks),
    thesisBreakConditions: arrayOfText(input.thesisBreakConditions),
    monitoringMetrics: arrayOfText(input.monitoringMetrics),
    requiredManualEvidence: arrayOfText(input.requiredManualEvidence),
    approvedBy: approvedAt ? text(input.approvedBy || 'owner', 200) : null,
    approvedAt,
    reviewDueAt,
    createdAt: input.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const minimumFields = [
    ['businessModel', Boolean(card.businessModel)],
    ['revenueDrivers', card.revenueDrivers.length > 0],
    ['moatEvidence', card.moatEvidence.length > 0],
    ['disruptionRisks', card.disruptionRisks.length > 0],
    ['thesisBreakConditions', card.thesisBreakConditions.length > 0],
    ['monitoringMetrics', card.monitoringMetrics.length > 0],
  ];
  card.completeness = minimumFields.filter(([, ok]) => ok).length / minimumFields.length;
  if (card.status === 'APPROVED' && card.completeness < 1) {
    throw new Error('THESIS_CARD_INCOMPLETE_CANNOT_APPROVE');
  }
  return card;
}

function isThesisApproved(card, now = new Date()) {
  if (!card || card.status !== 'APPROVED') return { approved: false, reason: 'THESIS_NOT_APPROVED' };
  if (!card.reviewDueAt || new Date(card.reviewDueAt).getTime() <= now.getTime()) {
    return { approved: false, reason: 'THESIS_REVIEW_EXPIRED' };
  }
  if (Number(card.completeness || 0) < 1) return { approved: false, reason: 'THESIS_CARD_INCOMPLETE' };
  return { approved: true, reason: 'THESIS_APPROVED', reviewDueAt: card.reviewDueAt };
}

async function putThesisCard(input, event) {
  const card = buildThesisCard(input);
  const store = await getStore(event, 'prefer-strong');
  await store.set(keyFor(card.symbol), JSON.stringify(card), {
    metadata: { symbol: card.symbol, status: card.status, updatedAt: card.updatedAt },
  });
  return card;
}

async function getThesisCard(symbol, event) {
  const store = await getStore(event);
  return store.get(keyFor(symbol), { type: 'json' });
}

async function listThesisCards(event) {
  const store = await getStore(event);
  const { blobs } = await store.list({ prefix: PREFIX });
  const cards = [];
  for (const blob of blobs) {
    const card = await store.get(blob.key, { type: 'json' });
    if (card) cards.push(card);
  }
  return cards.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

module.exports = {
  buildThesisCard,
  isThesisApproved,
  putThesisCard,
  getThesisCard,
  listThesisCards,
  _test: { normalizeSymbol, keyFor },
};
