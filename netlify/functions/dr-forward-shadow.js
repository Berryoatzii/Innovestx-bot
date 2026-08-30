const crypto = require('node:crypto');

const universe = require('../../config/research-universe-dr-pilot-2026.json');
const { fetchDailyHistory } = require('../lib/research-market-data');
const { isSetTradingDay } = require('../lib/market-calendar');
const {
  buildObservation,
  summarizeLedger,
} = require('../lib/dr-forward-shadow');
const {
  getForwardShadowLedger,
  appendForwardShadowObservation,
} = require('../lib/dr-forward-shadow-store');

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

function getHeader(headers = {}, name) {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function safeEqual(left, right) {
  const aa = Buffer.from(String(left || ''));
  const bb = Buffer.from(String(right || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function isScheduledInvocation(event = {}) {
  return Boolean(
    event.next_run
    || event.nextRun
    || event.triggerSource === 'schedule'
    || getHeader(event.headers, 'x-netlify-event').toLowerCase() === 'schedule'
  );
}

function isAuthorizedRead(event = {}) {
  const expected = process.env.ADMIN_TOKEN || '';
  return Boolean(expected && safeEqual(getHeader(event.headers, 'x-admin-token'), expected));
}

function publicSummary(ledger = {}) {
  const summary = summarizeLedger(ledger);
  return {
    candidateId: summary.candidateId || null,
    strategyVersion: summary.strategyVersion || null,
    passed: Boolean(summary.passed),
    tradingDays: Number(summary.tradingDays || 0),
    instrumentDecisionEvents: Number(summary.instrumentDecisionEvents || 0),
    rebalanceEvents: Number(summary.rebalanceEvents || 0),
    dataErrors: Number(summary.dataErrors || 0),
    cleanWindowStartedAt: summary.cleanWindowStartedAt || null,
    lastObservationDate: summary.lastObservationDate || null,
    brokerCalled: false,
    orderIntentCreated: false,
    moneyMoving: false,
    liveTradingEnabled: false,
  };
}

async function runDrForwardShadow(event = {}, options = {}) {
  const now = options.now || new Date();
  const day = isSetTradingDay(now, options.env || process.env);
  if (!day.openDay) {
    return {
      skipped: true,
      reason: day.reason,
      date: day.isoDate,
      brokerCalled: false,
      orderIntentCreated: false,
      moneyMoving: false,
    };
  }

  const getLedger = options.getLedger || getForwardShadowLedger;
  const append = options.append || appendForwardShadowObservation;
  const fetchHistory = options.fetchHistory || fetchDailyHistory;
  const current = await getLedger(event, 'strong');
  const histories = {};
  const dataErrors = [];
  for (const instrument of universe.instruments) {
    try {
      histories[instrument.benchmark] = await fetchHistory(instrument.benchmark, {
        range: '10y',
        market: 'US',
        timeoutMs: 15000,
      });
    } catch (error) {
      dataErrors.push({ benchmark: instrument.benchmark, error: error.message });
    }
  }
  const observation = buildObservation({
    date: day.isoDate,
    collectedAt: options.collectedAt || (options.now ? now : new Date()),
    histories,
    dataErrors,
    previousObservation: current.ledger.observations.at(-1) || null,
  });
  const saved = await append(observation, event);
  return {
    skipped: false,
    created: saved.created,
    persisted: saved.persisted,
    date: day.isoDate,
    summary: publicSummary(saved.ledger),
    brokerCalled: false,
    orderIntentCreated: false,
    moneyMoving: false,
  };
}

exports.handler = async (event = {}) => {
  const scheduled = isScheduledInvocation(event);
  try {
    if (scheduled) {
      const result = await runDrForwardShadow(event);
      return jsonResponse(200, { ok: true, ...result });
    }
    if (String(event.httpMethod || 'GET').toUpperCase() !== 'GET') {
      return jsonResponse(405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    }
    if (!isAuthorizedRead(event)) return jsonResponse(401, { ok: false, error: 'UNAUTHORIZED' });
    const { ledger } = await getForwardShadowLedger(event, 'strong');
    return jsonResponse(200, { ok: true, summary: publicSummary(ledger) });
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: scheduled || isAuthorizedRead(event) ? error.message : 'FORWARD_SHADOW_UNAVAILABLE',
      brokerCalled: false,
      orderIntentCreated: false,
      moneyMoving: false,
      liveTradingEnabled: false,
    });
  }
};

module.exports.runDrForwardShadow = runDrForwardShadow;
module.exports._test = {
  jsonResponse,
  getHeader,
  safeEqual,
  isScheduledInvocation,
  isAuthorizedRead,
  publicSummary,
};
