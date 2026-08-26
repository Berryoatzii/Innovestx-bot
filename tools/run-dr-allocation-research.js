const universe = require('../config/research-universe-dr-pilot-2026.json');
const { fetchDailyHistory } = require('../netlify/lib/research-market-data');
const {
  monthlyCloses,
  runAllocationStressMatrix,
} = require('../netlify/lib/diversified-allocation-research');

function convertToThb(candles, fxCandles) {
  const fxByDate = new Map((fxCandles || []).map((row) => [row.date, Number(row.close)]));
  return (candles || []).flatMap((row) => {
    const fx = fxByDate.get(row.date);
    if (!Number.isFinite(fx) || fx <= 0) return [];
    const adjusted = Number(row.adjustedClose ?? row.close);
    if (!Number.isFinite(adjusted) || adjusted <= 0) return [];
    return [{ ...row, adjustedClose: adjusted * fx, close: Number(row.close) * fx }];
  });
}

async function run() {
  const fx = await fetchDailyHistory('THB=X', { range: '10y', market: 'US' });
  const histories = {};
  const sources = [];
  for (const instrument of universe.instruments) {
    const proxy = await fetchDailyHistory(instrument.benchmark, { range: '10y', market: 'US' });
    const monthly = monthlyCloses(convertToThb(proxy.candles, fx.candles));
    histories[instrument.symbol] = monthly;
    sources.push({
      symbol: instrument.symbol,
      proxy: instrument.benchmark,
      months: monthly.length,
      firstMonth: monthly[0]?.month || null,
      lastMonth: monthly.at(-1)?.month || null,
    });
  }
  const validation = runAllocationStressMatrix(histories, {
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
  return {
    generatedAt: new Date().toISOString(),
    authority: 'RESEARCH_ONLY_NO_ORDERS',
    strategy: validation.strategy,
    preregistration: 'docs/DR_ALLOCATION_PREREGISTRATION_2026-08-06.md',
    assumptions: {
      proxyData: 'YAHOO_FINANCE_RESEARCH_ONLY',
      currencyApproximation: 'PROXY_ADJUSTED_CLOSE_X_SAME_DAY_USDTHB',
      noParameterSearchAfterResults: true,
    },
    sources,
    validation,
    realMoney: 'REAL-NO-GO',
  };
}

if (require.main === module) {
  run().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { convertToThb, run };
