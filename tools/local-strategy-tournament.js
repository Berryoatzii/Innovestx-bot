const set50Universe = require('../config/research-universe-set50-h2-2026.json');
const { fetchDailyHistory } = require('../netlify/lib/research-market-data');
const { evaluateActiveStrategy } = require('../netlify/lib/deterministic-strategy');
const { evaluatorFor, benchmarkEvaluatorFor } = require('../netlify/lib/research-strategy-variants');
const { runPortfolioValidationSuite } = require('../netlify/lib/portfolio-backtest');

function concise(period) {
  return {
    passed: period.passed,
    scenarios: period.scenarios.map((item) => ({
      id: item.id,
      passed: item.passed,
      checks: item.checks,
      metrics: item.metrics,
    })),
  };
}

async function main() {
  const benchmark = await fetchDailyHistory('^SET.BK', { range: '10y' });
  const finalHoldoutBars = 504;
  const cutoff = benchmark.candles.at(-(finalHoldoutBars + 1))?.date;
  if (!cutoff) throw new Error('FINAL_HOLDOUT_CUTOFF_UNAVAILABLE');
  const developmentBenchmark = benchmark.candles.filter((item) => item.date < cutoff);
  const developmentHistories = {};
  const dataFailures = [];

  for (const symbol of set50Universe.symbols) {
    try {
      const history = await fetchDailyHistory(symbol, { range: '10y' });
      developmentHistories[symbol] = history.candles.filter((item) => item.date < cutoff);
    } catch (error) {
      dataFailures.push({ symbol, error: error.message });
    }
  }

  const eligibleSymbols = Object.entries(developmentHistories)
    .filter(([, candles]) => candles.length >= 220)
    .map(([symbol]) => symbol);
  const universeCoverage = eligibleSymbols.length / set50Universe.symbols.length;
  const candidates = {
    'MOMENTUM_BREAKOUT_V1.0.0': { signalEvaluator: evaluateActiveStrategy },
    'TURTLE_55_20_ADAPTIVE_V1': {
      signalEvaluator: evaluatorFor('TURTLE_55_20_V1'),
      benchmarkEvaluator: benchmarkEvaluatorFor('ADAPTIVE_TREND_V1'),
    },
    'DUAL_TREND_BREAKOUT_ADAPTIVE_V1': {
      signalEvaluator: evaluatorFor('DUAL_TREND_BREAKOUT_V1'),
      benchmarkEvaluator: benchmarkEvaluatorFor('ADAPTIVE_TREND_V1'),
    },
  };
  const results = [];
  for (const [id, candidate] of Object.entries(candidates)) {
    const validation = runPortfolioValidationSuite(developmentHistories, developmentBenchmark, {
      expectedSymbols: eligibleSymbols.length,
      signalEvaluator: candidate.signalEvaluator,
      ...(candidate.benchmarkEvaluator ? { benchmarkEvaluator: candidate.benchmarkEvaluator } : {}),
      initialCapital: 100000,
      maxPositionWeight: 0.05,
      boardLot: 100,
      benchmark: 'SET_INDEX_PROXY',
      minimumStressTrades: 5,
      minimumStressReturn: 0,
      maximumStressDrawdown: -0.25,
      oosBars: 252,
      minimumHoldoutTrades: 2,
      minimumPortfolioTrades: 25,
      minimumPortfolioHoldoutTrades: 8,
      minimumTradeCoverage: 0.20,
      minimumHoldoutTradeCoverage: 0.10,
      minimumWinningBreadth: 0.40,
      minimumDataCoverage: 1,
    });
    results.push({
      id,
      passed: validation.passed && universeCoverage >= 0.90,
      universeCoverage,
      fullSample: concise(validation.fullSample),
      developmentHoldout: concise(validation.recentHoldout),
    });
  }

  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    authority: 'LOCAL_PUBLIC_MARKET_DATA_READ_ONLY',
    phase: 'DEVELOPMENT_ONLY',
    finalHoldoutOpened: false,
    finalHoldoutStartDate: cutoff,
    universe: set50Universe.name,
    eligibleSymbols: eligibleSymbols.length,
    universeCoverage,
    dataFailures,
    results,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
