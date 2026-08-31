const crypto = require('node:crypto');

const candidate = require('../../config/strategy-approval-candidate.json');
const researchCandidate = require('../../config/dr-strategy-research-candidate-rc2.json');
const universe = require('../../config/research-universe-dr-pilot-2026.json');
const {
  monthlyCloses,
  selectWithRetention,
} = require('./diversified-allocation-research');
const { isSetTradingDay } = require('./market-calendar');

const CANDIDATE_SHA256 = '609a4773b6a9f8bd93e103ba3cd36fa310402adcec4e82d27a187511d4262059';
const MINIMUM_TRADING_DAYS = 20;
const EXPECTED_SYMBOLS = candidate.approvalScope.symbols;
const MINIMUM_INSTRUMENT_DECISIONS = MINIMUM_TRADING_DAYS * EXPECTED_SYMBOLS.length;
const MINIMUM_REBALANCE_EVENTS = 1;
const EXPECTED_BENCHMARKS = universe.instruments.map((item) => item.benchmark);
const EXPECTED_BY_SYMBOL = Object.fromEntries(universe.instruments.map((item) => [item.symbol, item]));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function bkkMonth(date = new Date()) {
  const shifted = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 7);
}

function completedMonthlyRows(history = {}, now = new Date()) {
  const incompleteMonth = bkkMonth(now);
  return monthlyCloses(history.candles || []).filter((row) => row.month < incompleteMonth);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function alignedMonthlyHistory(monthlyByBenchmark = {}) {
  const supplied = Object.keys(monthlyByBenchmark).sort();
  const expected = [...EXPECTED_BENCHMARKS].sort();
  if (canonicalJson(supplied) !== canonicalJson(expected)) throw new Error('FORWARD_SHADOW_UNIVERSE_MISMATCH');
  const maps = Object.fromEntries(expected.map((symbol) => [
    symbol,
    new Map((monthlyByBenchmark[symbol] || []).map((row) => [row.month, Number(row.close)])),
  ]));
  const common = [...maps[expected[0]].keys()]
    .filter((month) => expected.every((symbol) => Number.isFinite(maps[symbol].get(month))))
    .sort();
  return { symbols: expected, maps, common };
}

function rankedAt(symbols, maps, common, index, logic) {
  const rows = symbols.map((benchmark) => {
    const current = maps[benchmark].get(common[index]);
    const trendRows = common.slice(index - logic.warmupMonths, index)
      .map((month) => maps[benchmark].get(month));
    const momentumBase = maps[benchmark].get(common[index - logic.momentumMonths]);
    const trendMean = mean(trendRows);
    const momentum = current / momentumBase - 1;
    return {
      benchmark,
      close: current,
      trendMean,
      momentum,
      eligible: current > trendMean && momentum > 0,
    };
  });
  return rows.sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    return right.momentum - left.momentum || left.benchmark.localeCompare(right.benchmark);
  });
}

function evaluateLatestSignal(monthlyByBenchmark = {}) {
  const logic = researchCandidate.signalLogic;
  const { symbols, maps, common } = alignedMonthlyHistory(monthlyByBenchmark);
  const startMonth = researchCandidate.validationDesign.finalHoldout.startMonth;
  const requestedStart = common.findIndex((month) => month >= startMonth);
  const startIndex = Math.max(logic.warmupMonths, requestedStart);
  if (requestedStart < 0 || startIndex >= common.length) throw new Error('FORWARD_SHADOW_INSUFFICIENT_MONTHS');

  let selected = [];
  let lastRebalanceMonth = null;
  for (let index = startIndex; index < common.length; index += 1) {
    if ((index - startIndex) % logic.rebalanceEveryMonths !== 0) continue;
    const eligible = rankedAt(symbols, maps, common, index, logic)
      .filter((row) => row.eligible)
      .map((row) => row.benchmark);
    selected = selectWithRetention(
      eligible,
      selected,
      logic.maximumSelected,
      logic.retentionRank,
    );
    lastRebalanceMonth = common[index];
  }

  const signalIndex = common.length - 1;
  const ranked = rankedAt(symbols, maps, common, signalIndex, logic);
  let eligibleRank = 0;
  const instruments = ranked.map((row) => {
    if (row.eligible) eligibleRank += 1;
    return {
      ...row,
      rank: row.eligible ? eligibleRank : null,
      selected: selected.includes(row.benchmark),
    };
  });
  return {
    signalMonth: common[signalIndex],
    lastRebalanceMonth,
    rebalancedForSignalMonth: lastRebalanceMonth === common[signalIndex],
    selected,
    instruments,
  };
}

function createLedger() {
  return summarizeLedger({
    schemaVersion: 1,
    evidenceType: 'DR_FORWARD_SHADOW',
    candidateId: candidate.candidateId,
    strategyVersion: candidate.strategyVersion,
    candidateSha256: CANDIDATE_SHA256,
    authority: 'PUBLIC_MARKET_DATA_READ_ONLY',
    observations: [],
  });
}

function buildObservation(input = {}) {
  const date = String(input.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('FORWARD_SHADOW_DATE_INVALID');
  const collectedAt = new Date(input.collectedAt || Date.now());
  if (!Number.isFinite(collectedAt.getTime())) throw new Error('FORWARD_SHADOW_TIME_INVALID');
  const dataErrors = Array.isArray(input.dataErrors)
    ? input.dataErrors.map((item) => ({
      benchmark: String(item.benchmark || ''),
      error: String(item.error || '').slice(0, 240),
    }))
    : [];
  let signal = null;
  let instruments = [];
  if (dataErrors.length === 0) {
    const histories = input.histories || {};
    const monthly = Object.fromEntries(EXPECTED_BENCHMARKS.map((benchmark) => [
      benchmark,
      completedMonthlyRows(histories[benchmark], collectedAt),
    ]));
    signal = evaluateLatestSignal(monthly);
    const byBenchmark = Object.fromEntries(signal.instruments.map((row) => [row.benchmark, row]));
    instruments = universe.instruments.map((instrument) => {
      const row = byBenchmark[instrument.benchmark];
      const history = histories[instrument.benchmark] || {};
      const latestDaily = (history.candles || []).at(-1) || {};
      return {
        symbol: instrument.symbol,
        benchmark: instrument.benchmark,
        signalMonth: signal.signalMonth,
        close: row.close,
        trendMean: row.trendMean,
        momentum: row.momentum,
        eligible: row.eligible,
        rank: row.rank,
        selected: row.selected,
        latestDailyDate: latestDaily.date || null,
        source: history.source || 'YAHOO_FINANCE_RESEARCH_ONLY',
        sourceFetchedAt: history.fetchedAt || null,
        officialProductUrl: instrument.officialUrl,
      };
    });
  }
  const previousSignalMonth = input.previousObservation?.signalMonth || null;
  return {
    date,
    collectedAt: collectedAt.toISOString(),
    marketOpenDay: true,
    signalMonth: signal?.signalMonth || null,
    lastRebalanceMonth: signal?.lastRebalanceMonth || null,
    rebalanceEvent: Boolean(
      signal?.rebalancedForSignalMonth && signal.signalMonth !== previousSignalMonth
    ),
    selectedDrSymbols: signal
      ? universe.instruments
        .filter((instrument) => signal.selected.includes(instrument.benchmark))
        .map((instrument) => instrument.symbol)
      : [],
    instruments,
    dataErrors,
    publicDataOnly: true,
    brokerCalled: false,
    orderIntentCreated: false,
    moneyMoving: false,
  };
}

function observationPayload(observation = {}) {
  const { observationSha256, ...payload } = observation;
  return payload;
}

function validateObservationShape(observation = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(observation.date || ''))) return false;
  const tradingDay = isSetTradingDay(new Date(`${observation.date}T05:00:00.000Z`));
  if (!tradingDay.openDay || tradingDay.isoDate !== observation.date) return false;
  const collectedAt = Date.parse(String(observation.collectedAt || ''));
  if (!Number.isFinite(collectedAt)) return false;
  const collectedBkkDate = new Date(collectedAt + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (collectedBkkDate !== observation.date) return false;
  if (observation.marketOpenDay !== true || observation.publicDataOnly !== true) return false;
  if (observation.brokerCalled !== false || observation.orderIntentCreated !== false || observation.moneyMoving !== false) {
    return false;
  }
  if (!Array.isArray(observation.dataErrors) || !Array.isArray(observation.instruments)) return false;
  if (!Array.isArray(observation.selectedDrSymbols)) return false;
  if (observation.dataErrors.length > 0) {
    return observation.instruments.length === 0
      && observation.signalMonth === null
      && observation.lastRebalanceMonth === null
      && observation.rebalanceEvent === false
      && observation.selectedDrSymbols.length === 0;
  }
  if (!/^\d{4}-\d{2}$/.test(String(observation.signalMonth || ''))) return false;
  if (!/^\d{4}-\d{2}$/.test(String(observation.lastRebalanceMonth || ''))) return false;
  const symbols = observation.instruments.map((item) => item.symbol).sort();
  if (canonicalJson(symbols) !== canonicalJson([...EXPECTED_SYMBOLS].sort())) return false;
  const seen = new Set();
  for (const item of observation.instruments) {
    const expected = EXPECTED_BY_SYMBOL[item.symbol];
    if (!expected || seen.has(item.symbol)) return false;
    seen.add(item.symbol);
    if (item.benchmark !== expected.benchmark || item.officialProductUrl !== expected.officialUrl) return false;
    if (item.signalMonth !== observation.signalMonth) return false;
    if (item.source !== 'YAHOO_FINANCE_RESEARCH_ONLY') return false;
    const fetchedAt = Date.parse(String(item.sourceFetchedAt || ''));
    if (!Number.isFinite(fetchedAt) || fetchedAt > collectedAt) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.latestDailyDate || ''))) return false;
    if (![item.close, item.trendMean, item.momentum].every(Number.isFinite)) return false;
    if (item.eligible !== (item.close > item.trendMean && item.momentum > 0)) return false;
    if (typeof item.selected !== 'boolean') return false;
  }
  const eligible = observation.instruments
    .filter((item) => item.eligible)
    .sort((left, right) => right.momentum - left.momentum || left.benchmark.localeCompare(right.benchmark));
  if (!eligible.every((item, index) => item.rank === index + 1)) return false;
  if (observation.instruments.some((item) => !item.eligible && item.rank !== null)) return false;
  const selected = universe.instruments
    .filter((expected) => observation.instruments.some((item) => item.symbol === expected.symbol && item.selected))
    .map((item) => item.symbol);
  return selected.length <= researchCandidate.signalLogic.maximumSelected
    && canonicalJson(selected) === canonicalJson(observation.selectedDrSymbols);
}

function cleanWindow(observations = []) {
  let lastFailure = -1;
  observations.forEach((observation, index) => {
    if (!validateObservationShape(observation) || observation.dataErrors.length > 0) lastFailure = index;
  });
  return observations.slice(lastFailure + 1);
}

function summarizeLedger(ledger = {}) {
  const observations = Array.isArray(ledger.observations) ? ledger.observations : [];
  const window = cleanWindow(observations);
  const tradingDays = new Set(window.map((item) => item.date)).size;
  const instrumentDecisionEvents = window.reduce((sum, item) => sum + item.instruments.length, 0);
  const rebalanceEvents = window.filter((item) => item.rebalanceEvent === true).length;
  const dataErrors = window.reduce((sum, item) => sum + item.dataErrors.length, 0);
  const passed = tradingDays >= MINIMUM_TRADING_DAYS
    && instrumentDecisionEvents >= MINIMUM_INSTRUMENT_DECISIONS
    && rebalanceEvents >= MINIMUM_REBALANCE_EVENTS
    && dataErrors === 0;
  return {
    ...ledger,
    passed,
    tradingDays,
    instrumentDecisionEvents,
    rebalanceEvents,
    dataErrors,
    cleanWindowStartedAt: window[0]?.date || null,
    lastObservationDate: observations.at(-1)?.date || null,
    brokerCalled: false,
    orderIntentCreated: false,
    moneyMoving: false,
  };
}

function appendObservation(ledger = createLedger(), observation = {}) {
  if (!verifyLedgerIdentity(ledger)) throw new Error('FORWARD_SHADOW_LEDGER_IDENTITY_MISMATCH');
  const existing = ledger.observations.find((item) => item.date === observation.date);
  if (existing) return { ledger, created: false, observation: existing };
  const previous = ledger.observations.at(-1) || null;
  if (previous && String(observation.date) <= String(previous.date)) {
    throw new Error('FORWARD_SHADOW_DATE_NOT_APPEND_ONLY');
  }
  if (!validateObservationShape(observation)) throw new Error('FORWARD_SHADOW_OBSERVATION_INVALID');
  const next = {
    ...observation,
    sequence: ledger.observations.length + 1,
    previousSha256: previous?.observationSha256 || null,
  };
  next.observationSha256 = sha256(canonicalJson(observationPayload(next)));
  const summarized = summarizeLedger({
    ...ledger,
    observations: [...ledger.observations, next],
  });
  return { ledger: summarized, created: true, observation: next };
}

function verifyLedgerIdentity(ledger = {}) {
  return ledger.schemaVersion === 1
    && ledger.evidenceType === 'DR_FORWARD_SHADOW'
    && ledger.candidateId === candidate.candidateId
    && ledger.strategyVersion === candidate.strategyVersion
    && ledger.candidateSha256 === CANDIDATE_SHA256
    && ledger.authority === 'PUBLIC_MARKET_DATA_READ_ONLY';
}

function verifyLedgerIntegrity(ledger = {}) {
  if (!verifyLedgerIdentity(ledger) || !Array.isArray(ledger.observations)) return false;
  let previousHash = null;
  let previousDate = null;
  for (let index = 0; index < ledger.observations.length; index += 1) {
    const observation = ledger.observations[index];
    if (!validateObservationShape(observation)) return false;
    if (observation.sequence !== index + 1) return false;
    if (observation.previousSha256 !== previousHash) return false;
    if (previousDate && observation.date <= previousDate) return false;
    const priorSignalMonth = index > 0 ? ledger.observations[index - 1].signalMonth : null;
    const expectedRebalance = observation.signalMonth !== null
      && observation.signalMonth === observation.lastRebalanceMonth
      && observation.signalMonth !== priorSignalMonth;
    if (observation.rebalanceEvent !== expectedRebalance) return false;
    const actual = sha256(canonicalJson(observationPayload(observation)));
    if (actual !== observation.observationSha256) return false;
    previousHash = actual;
    previousDate = observation.date;
  }
  const summary = summarizeLedger({ ...ledger });
  return [
    'passed',
    'tradingDays',
    'instrumentDecisionEvents',
    'rebalanceEvents',
    'dataErrors',
    'cleanWindowStartedAt',
    'lastObservationDate',
    'brokerCalled',
    'orderIntentCreated',
    'moneyMoving',
  ].every((key) => canonicalJson(summary[key]) === canonicalJson(ledger[key]));
}

function verifyForwardShadowLedger(ledger = {}, expected = {}) {
  return verifyLedgerIntegrity(ledger)
    && ledger.passed === true
    && ledger.candidateId === expected.candidateId
    && ledger.strategyVersion === expected.strategyVersion
    && ledger.candidateSha256 === expected.candidateSha256
    && ledger.tradingDays >= MINIMUM_TRADING_DAYS
    && ledger.instrumentDecisionEvents >= MINIMUM_INSTRUMENT_DECISIONS
    && ledger.rebalanceEvents >= MINIMUM_REBALANCE_EVENTS
    && ledger.dataErrors === 0
    && ledger.brokerCalled === false
    && ledger.orderIntentCreated === false
    && ledger.moneyMoving === false;
}

module.exports = {
  CANDIDATE_SHA256,
  MINIMUM_TRADING_DAYS,
  MINIMUM_INSTRUMENT_DECISIONS,
  MINIMUM_REBALANCE_EVENTS,
  completedMonthlyRows,
  evaluateLatestSignal,
  createLedger,
  buildObservation,
  appendObservation,
  summarizeLedger,
  verifyLedgerIntegrity,
  verifyForwardShadowLedger,
  _test: { canonicalJson, sha256, validateObservationShape, cleanWindow, bkkMonth },
};
