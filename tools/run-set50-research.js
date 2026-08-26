const universe = require('../config/research-universe-set50-h2-2026.json');
const { fetchDailyHistory } = require('../netlify/lib/research-market-data');
const { runBacktestValidationSuite } = require('../netlify/lib/backtest-engine');
const { evaluateBacktestGate } = require('../netlify/lib/research-results-store');

function finite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const options = { limit: universe.symbols.length, range: '5y', researchCapital: 100000, pilotCapital: 3500 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--limit') options.limit = Math.max(1, Math.floor(finite(value, options.limit)));
    if (key === '--range') options.range = String(value || options.range);
    if (key === '--research-capital') options.researchCapital = Math.max(1, finite(value, options.researchCapital));
    if (key === '--pilot-capital') options.pilotCapital = Math.max(1, finite(value, options.pilotCapital));
  }
  return options;
}

function compactValidation(validation) {
  const stress = validation.fullSample;
  const resultWithRobustness = {
    ...stress.baseline,
    robustness: { passed: validation.passed },
  };
  return {
    stressPassed: stress.passed,
    holdoutPassed: validation.recentHoldout.passed,
    validationPassed: validation.passed,
    holdoutStartDate: validation.recentHoldout.startDate,
    strategyGate: evaluateBacktestGate(resultWithRobustness),
    worstTotalReturn: stress.worstTotalReturn,
    worstDrawdown: stress.worstDrawdown,
    scenarios: stress.scenarios.map((row) => ({ id: row.id, metrics: row.metrics })),
    holdoutScenarios: validation.recentHoldout.scenarios.map((row) => ({ id: row.id, metrics: row.metrics })),
  };
}

async function analyzeSymbol(symbol, benchmark, options) {
  const history = await fetchDailyHistory(symbol, { range: options.range });
  const common = {
    symbol,
    maxPositionWeight: 0.05,
    boardLot: 100,
    benchmark: 'SET_INDEX_PROXY',
  };
  const research = runBacktestValidationSuite(history.candles, benchmark.candles, {
    ...common,
    initialCapital: options.researchCapital,
  });
  const pilot = runBacktestValidationSuite(history.candles, benchmark.candles, {
    ...common,
    initialCapital: options.pilotCapital,
  });
  const last = history.candles.at(-1) || {};
  return {
    symbol,
    lastDate: last.date || null,
    lastPrice: last.close || null,
    lastVolume: last.volume || null,
    minimumBoardLotValue: Number(last.close || 0) * 100,
    minimumCapitalAtPolicyWeight: Number(last.close || 0) * 100 / common.maxPositionWeight,
    research: compactValidation(research),
    pilot: compactValidation(pilot),
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date().toISOString().slice(0, 10);
  if (now < universe.validFrom || now > universe.validThrough) {
    throw new Error(`RESEARCH_UNIVERSE_STALE:${universe.validThrough}`);
  }
  const benchmark = await fetchDailyHistory('^SET.BK', { range: options.range });
  const symbols = universe.symbols.slice(0, options.limit);
  const results = [];
  for (const symbol of symbols) {
    try {
      results.push(await analyzeSymbol(symbol, benchmark, options));
    } catch (error) {
      results.push({ symbol, error: error.message });
    }
  }
  const successful = results.filter((row) => !row.error);
  const output = {
    generatedAt: new Date().toISOString(),
    authority: 'RESEARCH_ONLY_NO_ORDERS',
    universe: {
      name: universe.name,
      validFrom: universe.validFrom,
      validThrough: universe.validThrough,
      sourceUrl: universe.sourceUrl,
      tested: symbols.length,
    },
    assumptions: options,
    summary: {
      dataSuccess: successful.length,
      dataFailures: results.length - successful.length,
      researchStressPassed: successful.filter((row) => row.research.stressPassed).length,
      researchHoldoutPassed: successful.filter((row) => row.research.holdoutPassed).length,
      researchValidationPassed: successful.filter((row) => row.research.validationPassed).length,
      researchStrategyPassed: successful.filter((row) => row.research.strategyGate.passed).length,
      pilotStressPassed: successful.filter((row) => row.pilot.stressPassed).length,
      pilotHoldoutPassed: successful.filter((row) => row.pilot.holdoutPassed).length,
      pilotValidationPassed: successful.filter((row) => row.pilot.validationPassed).length,
      pilotStrategyPassed: successful.filter((row) => row.pilot.strategyGate.passed).length,
      pilotBoardLotAffordable: successful.filter((row) => row.minimumBoardLotValue <= options.pilotCapital).length,
      pilotPolicyAffordable: successful.filter((row) => row.minimumCapitalAtPolicyWeight <= options.pilotCapital).length,
      pilotGeneratedTrades: successful.filter((row) =>
        row.pilot.scenarios.some((scenario) => Number(scenario.metrics.completedTrades || 0) > 0)
      ).length,
    },
    results,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
