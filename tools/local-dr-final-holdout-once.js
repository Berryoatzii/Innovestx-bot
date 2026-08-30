const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const candidate = require('../config/dr-strategy-research-candidate-rc2.json');
const universe = require('../config/research-universe-dr-pilot-2026.json');
const { fetchDailyHistory } = require('../netlify/lib/research-market-data');
const {
  monthlyCloses,
  runMonthlyAllocation,
} = require('../netlify/lib/diversified-allocation-research');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_PATH = path.join(ROOT, 'config', 'dr-strategy-final-holdout-rc2.json');
const FROZEN_COMMIT = 'c8a2d2d70fc7ec908d3bdfc7d6d3dc0049c2c1b4';
const FROZEN_CANDIDATE_SHA256 = 'b789d8c63f75db090b789d56c116a92a638a653e7215d7a6097338cb3602438c';

function hashFile(relativePath) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, relativePath)))
    .digest('hex');
}

function previousCompletedUtcMonth() {
  const now = new Date();
  const completed = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${completed.getUTCFullYear()}-${String(completed.getUTCMonth() + 1).padStart(2, '0')}`;
}

function evaluate(result) {
  const thresholds = candidate.validationDesign;
  const checks = {
    positiveReturn: result.metrics.totalReturn > 0,
    positiveExcess: result.metrics.excessVsBenchmark > 0,
    drawdownControlled: result.metrics.maxDrawdown >= thresholds.maximumDrawdown,
    enoughDecisions: result.metrics.decisions >= thresholds.minimumDecisions,
    enoughPositionChanges: result.metrics.positionChanges >= thresholds.minimumPositionChanges,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

async function main() {
  if (fs.existsSync(EVIDENCE_PATH)) throw new Error('FINAL_HOLDOUT_ALREADY_OPENED');
  if (candidate.validationDesign.finalHoldout.opened !== false) throw new Error('FINAL_HOLDOUT_NOT_SEALED');
  if (hashFile('config/dr-strategy-research-candidate-rc2.json') !== FROZEN_CANDIDATE_SHA256) {
    throw new Error('FROZEN_CANDIDATE_HASH_MISMATCH');
  }
  for (const reference of [candidate.universeRef, ...candidate.implementationRefs]) {
    if (hashFile(reference.path) !== reference.sha256) throw new Error('FROZEN_IMPLEMENTATION_HASH_MISMATCH');
  }

  const completedThroughMonth = previousCompletedUtcMonth();
  const finalStart = candidate.validationDesign.finalHoldout.startMonth;
  const histories = {};
  for (const instrument of universe.instruments) {
    const history = await fetchDailyHistory(instrument.benchmark, { range: '10y', market: 'US' });
    histories[instrument.benchmark] = monthlyCloses(history.candles)
      .filter((row) => row.month <= completedThroughMonth);
  }
  if (!histories.SPY.some((row) => row.month === finalStart)) throw new Error('FINAL_HOLDOUT_START_UNAVAILABLE');
  if (!histories.SPY.some((row) => row.month === completedThroughMonth)) {
    throw new Error('LATEST_COMPLETED_MONTH_UNAVAILABLE');
  }

  const logic = candidate.signalLogic;
  const scenarios = candidate.validationDesign.stressTurnoverCostRates.map((costRate) => {
    const result = runMonthlyAllocation(histories, {
      evaluationStartMonth: finalStart,
      warmupMonths: logic.warmupMonths,
      momentumMonths: logic.momentumMonths,
      maxSelected: logic.maximumSelected,
      retentionRank: logic.retentionRank,
      positionWeight: logic.positionWeight,
      rebalanceEveryMonths: logic.rebalanceEveryMonths,
      costRate,
    });
    return { costRate, metrics: result.metrics, gate: evaluate(result) };
  });

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    strategyVersion: candidate.strategyVersion,
    candidateSha256: FROZEN_CANDIDATE_SHA256,
    frozenCommit: FROZEN_COMMIT,
    authority: 'LOCAL_PUBLIC_MARKET_DATA_READ_ONLY',
    finalHoldoutOpened: true,
    openedAt: new Date().toISOString(),
    startMonth: finalStart,
    completedThroughMonth,
    passed: scenarios.every((row) => row.gate.passed),
    scenarios,
    releaseLocks: candidate.releaseLocks,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
