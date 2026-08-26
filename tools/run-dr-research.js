const universe = require('../config/research-universe-dr-pilot-2026.json');
const { fetchDailyHistory } = require('../netlify/lib/research-market-data');
const { runBacktestValidationSuite } = require('../netlify/lib/backtest-engine');
const { evaluateBacktestGate } = require('../netlify/lib/research-results-store');

function finite(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const options = { range: '5y', researchCapital: 100000, pilotCapital: 3500 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--range') options.range = String(value || options.range);
    if (key === '--research-capital') options.researchCapital = Math.max(1, finite(value, options.researchCapital));
    if (key === '--pilot-capital') options.pilotCapital = Math.max(1, finite(value, options.pilotCapital));
  }
  return options;
}

function buildThbBenchmark(benchmarkCandles, fxCandles) {
  const fxByDate = new Map((fxCandles || []).map((row) => [row.date, Number(row.close)]));
  return (benchmarkCandles || []).flatMap((row) => {
    const fx = fxByDate.get(row.date);
    if (!Number.isFinite(fx) || fx <= 0) return [];
    return [{
      ...row,
      open: Number(row.open) * fx,
      high: Number(row.high) * fx,
      low: Number(row.low) * fx,
      close: Number(row.close) * fx,
      adjustedClose: Number(row.adjustedClose ?? row.close) * fx,
    }];
  });
}

function compactValidation(validation) {
  const stress = validation.fullSample;
  const resultWithRobustness = { ...stress.baseline, robustness: { passed: validation.passed } };
  return {
    stressPassed: stress.passed,
    holdoutPassed: validation.recentHoldout.passed,
    validationPassed: validation.passed,
    holdoutStartDate: validation.recentHoldout.startDate,
    strategyGate: evaluateBacktestGate(resultWithRobustness),
    worstTotalReturn: stress.worstTotalReturn,
    worstDrawdown: stress.worstDrawdown,
    completedTrades: stress.baseline.metrics.completedTrades,
    decisions: stress.baseline.decisionLog.length,
    scenarios: stress.scenarios.map((row) => ({ id: row.id, metrics: row.metrics })),
    holdoutScenarios: validation.recentHoldout.scenarios.map((row) => ({ id: row.id, metrics: row.metrics })),
  };
}

async function analyzeInstrument(instrument, fx, options, benchmarkCache) {
  const history = await fetchDailyHistory(instrument.symbol, { range: options.range });
  if (!benchmarkCache.has(instrument.benchmark)) {
    benchmarkCache.set(instrument.benchmark, await fetchDailyHistory(instrument.benchmark, {
      range: options.range,
      market: 'US',
    }));
  }
  const rawBenchmark = benchmarkCache.get(instrument.benchmark);
  const benchmark = buildThbBenchmark(rawBenchmark.candles, fx.candles);
  const common = {
    symbol: instrument.symbol,
    maxPositionWeight: universe.maxPositionWeight,
    boardLot: universe.boardLot,
    benchmark: `${instrument.benchmark}_USD_X_USDTHB`,
  };
  const research = runBacktestValidationSuite(history.candles, benchmark, {
    ...common,
    initialCapital: options.researchCapital,
  });
  const pilot = runBacktestValidationSuite(history.candles, benchmark, {
    ...common,
    initialCapital: options.pilotCapital,
  });
  const last = history.candles.at(-1) || {};
  return {
    symbol: instrument.symbol,
    exposure: instrument.exposure,
    benchmark: common.benchmark,
    source: history.source,
    bars: history.candles.length,
    lastDate: last.date || null,
    lastPrice: last.close || null,
    lastVolume: last.volume || null,
    minimumBoardLotValue: Number(last.close || 0),
    minimumCapitalAtPolicyWeight: Number(last.close || 0) / universe.maxPositionWeight,
    research: compactValidation(research),
    pilot: compactValidation(pilot),
  };
}

async function run(options = parseArgs(process.argv.slice(2))) {
  const today = new Date().toISOString().slice(0, 10);
  if (today < universe.validFrom || today > universe.validThrough) {
    throw new Error(`DR_RESEARCH_UNIVERSE_STALE:${universe.validThrough}`);
  }
  const fx = await fetchDailyHistory('THB=X', { range: options.range, market: 'US' });
  const benchmarkCache = new Map();
  const results = [];
  for (const instrument of universe.instruments) {
    try {
      results.push(await analyzeInstrument(instrument, fx, options, benchmarkCache));
    } catch (error) {
      results.push({ symbol: instrument.symbol, error: error.message });
    }
  }
  const successful = results.filter((row) => !row.error);
  return {
    generatedAt: new Date().toISOString(),
    authority: universe.authority,
    universe: {
      name: universe.name,
      sourceUrl: universe.sourceUrl,
      tested: universe.instruments.length,
      boardLot: universe.boardLot,
    },
    assumptions: {
      ...options,
      benchmarkCurrency: 'THB_APPROXIMATION_USING_USDTHB_DAILY_CLOSE',
      benchmarkLimitation: 'Proxy ETFs may differ from the exact listed underlying and issuer conversion ratio.',
    },
    summary: {
      dataSuccess: successful.length,
      dataFailures: results.length - successful.length,
      researchValidationPassed: successful.filter((row) => row.research.validationPassed).length,
      pilotValidationPassed: successful.filter((row) => row.pilot.validationPassed).length,
      pilotPolicyAffordable: successful.filter((row) => row.minimumCapitalAtPolicyWeight <= options.pilotCapital).length,
      pilotGeneratedTrades: successful.filter((row) => row.pilot.completedTrades > 0).length,
    },
    results,
  };
}

if (require.main === module) {
  run().then((output) => {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildThbBenchmark, run };
