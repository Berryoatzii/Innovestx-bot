const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const candidate = require('../config/strategy-approval-candidate.json');
const researchCandidate = require('../config/dr-strategy-research-candidate-rc2.json');
const universe = require('../config/research-universe-dr-pilot-2026.json');
const { isSetTradingDay } = require('../netlify/lib/market-calendar');
const {
  monthlyCloses,
  runMonthlyAllocation,
} = require('../netlify/lib/diversified-allocation-research');
const {
  createLedger,
  buildObservation,
  appendObservation,
  evaluateLatestSignal,
  verifyLedgerIntegrity,
  MINIMUM_INSTRUMENT_DECISIONS,
} = require('../netlify/lib/dr-forward-shadow');
const { verifyForwardShadowEvidence } = require('../netlify/lib/real-money-release');
const { isVerifiedDrForwardShadow } = require('../netlify/lib/bot-readiness');
const { runDrForwardShadow } = require('../netlify/functions/dr-forward-shadow');

function monthKey(index) {
  const date = new Date(Date.UTC(2023, index, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function fakeHistories() {
  const slopes = [1.1, 1.8, 0.7, -0.25, 0.35, 1.35];
  return Object.fromEntries(universe.instruments.map((instrument, instrumentIndex) => {
    const candles = Array.from({ length: 44 }, (_, index) => {
      const close = 100 + slopes[instrumentIndex] * index + Math.sin(index / 3) * 0.2;
      return {
        date: `${monthKey(index)}-28`,
        open: close,
        high: close,
        low: close,
        close,
        adjustedClose: close,
        volume: 1000000,
      };
    });
    return [instrument.benchmark, {
      symbol: instrument.benchmark,
      source: 'YAHOO_FINANCE_RESEARCH_ONLY',
      fetchedAt: '2026-09-01T01:30:00.000Z',
      candles,
      events: [],
    }];
  }));
}

function tradingDates(start, count) {
  const rows = [];
  const cursor = new Date(`${start}T05:00:00.000Z`);
  while (rows.length < count) {
    const day = isSetTradingDay(cursor);
    if (day.openDay) rows.push(day.isoDate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

function completeLedger() {
  const histories = fakeHistories();
  let ledger = createLedger();
  let previous = null;
  for (const date of tradingDates('2026-09-01', 20)) {
    const observation = buildObservation({
      date,
      collectedAt: `${date}T01:45:00.000Z`,
      histories,
      previousObservation: previous,
    });
    const appended = appendObservation(ledger, observation);
    ledger = appended.ledger;
    previous = appended.observation;
  }
  return ledger;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('forward signal replays the exact frozen quarterly buffer logic', () => {
  const histories = fakeHistories();
  const monthlyThroughAugust = Object.fromEntries(Object.entries(histories).map(([symbol, history]) => [
    symbol,
    monthlyCloses(history.candles),
  ]));
  const monthlyThroughJuly = Object.fromEntries(Object.entries(monthlyThroughAugust).map(([symbol, rows]) => [
    symbol,
    rows.filter((row) => row.month <= '2026-07'),
  ]));
  const forward = evaluateLatestSignal(monthlyThroughJuly);
  const frozen = runMonthlyAllocation(monthlyThroughAugust, {
    evaluationStartMonth: researchCandidate.validationDesign.finalHoldout.startMonth,
    warmupMonths: researchCandidate.signalLogic.warmupMonths,
    momentumMonths: researchCandidate.signalLogic.momentumMonths,
    maxSelected: researchCandidate.signalLogic.maximumSelected,
    retentionRank: researchCandidate.signalLogic.retentionRank,
    positionWeight: researchCandidate.signalLogic.positionWeight,
    rebalanceEveryMonths: researchCandidate.signalLogic.rebalanceEveryMonths,
    costRate: 0,
  });

  assert.equal(forward.signalMonth, '2026-07');
  assert.equal(frozen.decisionLog.at(-1).signalMonth, forward.signalMonth);
  assert.deepEqual(frozen.decisionLog.at(-1).selected.sort(), [...forward.selected].sort());
});

test('append-only ledger needs 20 real SET days and one new rebalance month', () => {
  const ledger = completeLedger();

  assert.equal(MINIMUM_INSTRUMENT_DECISIONS, 120);
  assert.equal(ledger.passed, true);
  assert.equal(ledger.tradingDays, 20);
  assert.equal(ledger.instrumentDecisionEvents, 120);
  assert.equal(ledger.rebalanceEvents, 1);
  assert.equal(ledger.dataErrors, 0);
  assert.equal(ledger.brokerCalled, false);
  assert.equal(ledger.orderIntentCreated, false);
  assert.equal(ledger.moneyMoving, false);
  assert.equal(verifyLedgerIntegrity(ledger), true);
  assert.equal(ledger.observations[0].signalMonth, '2026-08');
  assert.equal(ledger.observations[0].rebalanceEvent, true);
  assert.ok(ledger.observations.slice(1).every((row) => row.rebalanceEvent === false));
});

test('weekends, duplicate dates and tampering cannot manufacture shadow evidence', () => {
  const histories = fakeHistories();
  const first = buildObservation({
    date: '2026-09-01',
    collectedAt: '2026-09-01T01:45:00.000Z',
    histories,
  });
  const appended = appendObservation(createLedger(), first);
  assert.equal(appendObservation(appended.ledger, first).created, false);
  const weekend = buildObservation({
    date: '2026-09-05',
    collectedAt: '2026-09-05T01:45:00.000Z',
    histories,
    previousObservation: appended.observation,
  });
  assert.throws(() => appendObservation(appended.ledger, weekend), /OBSERVATION_INVALID/);

  const tampered = structuredClone(completeLedger());
  tampered.observations[0].selectedDrSymbols = [];
  assert.equal(verifyLedgerIntegrity(tampered), false);
});

test('release verifier checks the full hash chain rather than trusting aggregate flags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-forward-shadow-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(
    path.resolve(__dirname, '../config/strategy-approval-candidate.json'),
    path.join(configDir, 'strategy-approval-candidate.json'),
  );
  const evidencePath = path.join(root, 'dr-forward-shadow.json');
  const ledger = completeLedger();
  fs.writeFileSync(evidencePath, `${JSON.stringify(ledger, null, 2)}\n`);
  const reference = { path: 'dr-forward-shadow.json', sha256: hashFile(evidencePath) };
  assert.equal(verifyForwardShadowEvidence(reference, root), true);

  ledger.observations[0].selectedDrSymbols = [];
  fs.writeFileSync(evidencePath, `${JSON.stringify(ledger, null, 2)}\n`);
  const tampered = { ...reference, sha256: hashFile(evidencePath) };
  assert.equal(verifyForwardShadowEvidence(tampered, root), false);
});

test('readiness recomputes the RC2 hash chain instead of trusting a stored passed flag', () => {
  const ledger = completeLedger();
  assert.equal(isVerifiedDrForwardShadow(ledger), true);

  const tampered = structuredClone(ledger);
  tampered.observations[0].selectedDrSymbols = [];
  tampered.passed = true;
  assert.equal(isVerifiedDrForwardShadow(tampered), false);
});

test('scheduled collector uses public histories and creates no broker or order state', async () => {
  const histories = fakeHistories();
  const initial = createLedger();
  const result = await runDrForwardShadow({}, {
    now: new Date('2026-09-01T01:45:00.000Z'),
    getLedger: async () => ({ ledger: initial, etag: null }),
    fetchHistory: async (benchmark) => histories[benchmark],
    append: async (observation) => ({
      ...appendObservation(initial, observation),
      persisted: true,
    }),
  });

  assert.equal(result.skipped, false);
  assert.equal(result.created, true);
  assert.equal(result.persisted, true);
  assert.equal(result.summary.tradingDays, 1);
  assert.equal(result.summary.instrumentDecisionEvents, 6);
  assert.equal(result.summary.rebalanceEvents, 1);
  assert.equal(result.brokerCalled, false);
  assert.equal(result.orderIntentCreated, false);
  assert.equal(result.moneyMoving, false);
  assert.equal(candidate.releaseConditions.forwardShadowEvidenceRequired, true);
});
