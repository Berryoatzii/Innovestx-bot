const { fetchDailyHistory } = require('../netlify/lib/research-market-data');
const { runBacktestValidationSuite } = require('../netlify/lib/backtest-engine');
const { runPortfolioValidationSuite } = require('../netlify/lib/portfolio-backtest');
const { loadPortfolioPolicy } = require('../netlify/lib/portfolio-policy');
const set50Universe = require('../config/research-universe-set50-h2-2026.json');

function round(value) {
  return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(6)) : null;
}

async function main() {
  const policy = loadPortfolioPolicy({});
  const portfolioSymbols = [...new Set([
    ...(policy.classification.coreSymbols || []),
    ...(policy.classification.activeSymbols || []),
    ...(policy.classification.reviewSymbols || []),
  ])].sort();
  const useSet50 = process.argv.includes('--set50');
  const symbols = useSet50 ? [...set50Universe.symbols].sort() : portfolioSymbols;
  const benchmark = await fetchDailyHistory('^SET.BK', { range: '10y' });
  const results = [];
  const histories = {};

  for (const symbol of symbols) {
    try {
      const history = await fetchDailyHistory(symbol, { range: '10y' });
      histories[symbol] = history.candles;
      const validation = runBacktestValidationSuite(history.candles, benchmark.candles, {
        symbol,
        initialCapital: 100000,
        maxPositionWeight: policy.active.maxPositionWeight,
        boardLot: 100,
        benchmark: 'SET_INDEX_PROXY',
        minimumStressTrades: 5,
        minimumStressReturn: 0,
        maximumStressDrawdown: -0.25,
        oosBars: 504,
        minimumHoldoutTrades: 3,
      });
      const metrics = validation.fullSample.baseline.metrics;
      results.push({
        symbol,
        passed: validation.passed,
        fullSamplePassed: validation.fullSample.passed,
        recentHoldoutPassed: validation.recentHoldout.passed,
        totalReturn: round(metrics.totalReturn),
        excessVsBenchmark: round(metrics.excessVsBenchmark),
        maxDrawdown: round(metrics.maxDrawdown),
        completedTrades: metrics.completedTrades,
        recentHoldoutWorstReturn: round(validation.recentHoldout.worstTotalReturn),
        recentHoldoutWorstDrawdown: round(validation.recentHoldout.worstDrawdown),
      });
    } catch (error) {
      results.push({ symbol, passed: false, error: error.message });
    }
  }

  const portfolioGate = process.argv.includes('--portfolio-gate')
    ? runPortfolioValidationSuite(histories, benchmark.candles, {
      expectedSymbols: symbols.length,
      initialCapital: 100000,
      maxPositionWeight: policy.active.maxPositionWeight,
      boardLot: 100,
      benchmark: 'SET_INDEX_PROXY',
      minimumStressTrades: 5,
      minimumStressReturn: 0,
      maximumStressDrawdown: -0.25,
      oosBars: 504,
      minimumHoldoutTrades: 3,
    })
    : null;

  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    authority: 'LOCAL_PUBLIC_MARKET_DATA_READ_ONLY',
    universe: useSet50 ? set50Universe.name : 'VERSIONED_PORTFOLIO_CLASSIFICATION',
    brokerContacted: false,
    orderIntentCreated: false,
    symbols: results.length,
    passed: results.filter((item) => item.passed).map((item) => item.symbol),
    portfolioGate,
    results,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
