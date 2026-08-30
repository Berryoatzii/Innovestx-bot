const universe = require('../config/research-universe-dr-pilot-2026.json');
const { fetchDailyHistory } = require('../netlify/lib/research-market-data');
const {
  monthlyCloses,
  runAllocationStressMatrix,
} = require('../netlify/lib/diversified-allocation-research');

async function main() {
  const histories = {};
  for (const instrument of universe.instruments) {
    const history = await fetchDailyHistory(instrument.benchmark, { range: '10y', market: 'US' });
    histories[instrument.benchmark] = monthlyCloses(history.candles);
  }
  const reference = histories.SPY;
  const finalHoldoutMonths = 24;
  const finalHoldoutStartMonth = reference.at(-(finalHoldoutMonths + 1))?.month;
  if (!finalHoldoutStartMonth) throw new Error('FINAL_HOLDOUT_CUTOFF_UNAVAILABLE');
  const development = Object.fromEntries(Object.entries(histories).map(([symbol, rows]) => [
    symbol,
    rows.filter((item) => item.month < finalHoldoutStartMonth),
  ]));
  const validation = runAllocationStressMatrix(development, {
    costs: [0.00268, 0.005, 0.01],
    holdoutMonths: 24,
    warmupMonths: 10,
    momentumMonths: 6,
    maxSelected: 3,
    positionWeight: 0.05,
    minimumDecisions: 12,
    minimumPositionChanges: 4,
    maximumDrawdown: -0.10,
  });
  const concise = (row) => ({ costRate: row.costRate, metrics: row.metrics, gate: row.gate });
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    authority: 'LOCAL_PUBLIC_MARKET_DATA_READ_ONLY',
    phase: 'DEVELOPMENT_ONLY',
    finalHoldoutOpened: false,
    finalHoldoutStartMonth,
    universe: universe.name,
    instruments: universe.instruments.map((item) => ({ symbol: item.symbol, benchmark: item.benchmark })),
    passed: validation.passed,
    fullSample: validation.scenarios.map(concise),
    developmentHoldout: {
      startMonth: validation.holdout.startMonth,
      scenarios: validation.holdout.scenarios.map(concise),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
