const { runBacktestValidationSuite } = require('./backtest-engine');

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function aggregateScenarioRows(rows, requirements = {}) {
  const items = Array.isArray(rows) ? rows.filter((item) => item?.metrics) : [];
  const expectedSymbols = Math.max(items.length, Number(requirements.expectedSymbols || items.length));
  const minimumTrades = Math.max(1, Number(requirements.minimumTrades ?? 20));
  const minimumReturn = Number(requirements.minimumReturn ?? 0);
  const minimumExcess = Number(requirements.minimumExcess ?? 0);
  const maximumDrawdown = Number(requirements.maximumDrawdown ?? -0.10);
  const minimumTradeCoverage = Number(requirements.minimumTradeCoverage ?? 0.20);
  const minimumWinningBreadth = Number(requirements.minimumWinningBreadth ?? 0.40);
  const minimumDataCoverage = Number(requirements.minimumDataCoverage ?? 0.95);

  const totalReturn = mean(items.map((item) => item.metrics.totalReturn));
  const excessVsBenchmark = mean(items.map((item) => item.metrics.excessVsBenchmark));
  const worstDrawdown = items.length > 0
    ? Math.min(...items.map((item) => Number(item.metrics.maxDrawdown || 0)))
    : null;
  const completedTrades = items.reduce((sum, item) => sum + Number(item.metrics.completedTrades || 0), 0);
  const liquidityRejectedOrders = items.reduce(
    (sum, item) => sum + Number(item.metrics.liquidityRejectedOrders || 0),
    0,
  );
  const tradedSymbols = items.filter((item) => Number(item.metrics.completedTrades || 0) > 0).length;
  const profitableSymbols = items.filter(
    (item) => Number(item.metrics.completedTrades || 0) > 0 && Number(item.metrics.totalReturn || 0) > 0,
  ).length;
  const dataCoverage = expectedSymbols > 0 ? items.length / expectedSymbols : 0;
  const tradeCoverage = expectedSymbols > 0 ? tradedSymbols / expectedSymbols : 0;
  const winningBreadth = tradedSymbols > 0 ? profitableSymbols / tradedSymbols : 0;

  const checks = {
    finiteMetrics: [totalReturn, excessVsBenchmark, worstDrawdown].every(Number.isFinite),
    dataCoverage: dataCoverage >= minimumDataCoverage,
    enoughTrades: completedTrades >= minimumTrades,
    positiveAfterCosts: Number.isFinite(totalReturn) && totalReturn > minimumReturn,
    positiveBenchmarkExcess: Number.isFinite(excessVsBenchmark) && excessVsBenchmark > minimumExcess,
    drawdownWithinLimit: Number.isFinite(worstDrawdown) && worstDrawdown >= maximumDrawdown,
    zeroLiquidityRejections: liquidityRejectedOrders === 0,
    tradeCoverage: tradeCoverage >= minimumTradeCoverage,
    winningBreadth: winningBreadth >= minimumWinningBreadth,
  };

  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    metrics: {
      expectedSymbols,
      evaluatedSymbols: items.length,
      tradedSymbols,
      profitableSymbols,
      dataCoverage,
      tradeCoverage,
      winningBreadth,
      completedTrades,
      totalReturn,
      excessVsBenchmark,
      worstDrawdown,
      liquidityRejectedOrders,
    },
    requirements: {
      minimumTrades,
      minimumReturn,
      minimumExcess,
      maximumDrawdown,
      minimumTradeCoverage,
      minimumWinningBreadth,
      minimumDataCoverage,
    },
  };
}

function aggregatePeriod(validations, period, requirements) {
  const scenarioIds = ['BASE', 'HIGH_FRICTION', 'SEVERE_FRICTION'];
  const scenarios = scenarioIds.map((id) => {
    const rows = validations.flatMap((item) => {
      const scenario = item.validation?.[period]?.scenarios?.find((row) => row.id === id);
      return scenario ? [{ symbol: item.symbol, metrics: scenario.metrics }] : [];
    });
    return { id, ...aggregateScenarioRows(rows, requirements) };
  });
  return { passed: scenarios.every((item) => item.passed), scenarios };
}

function runPortfolioValidationSuite(histories, benchmarkCandles, options = {}) {
  const minimumBars = Math.max(220, Number(options.warmupBars || 220));
  const entries = Object.entries(histories || {}).filter(
    ([, candles]) => Array.isArray(candles) && candles.length >= minimumBars,
  );
  const expectedSymbols = Number(options.expectedSymbols || entries.length);
  const validations = entries.map(([symbol, candles]) => ({
    symbol,
    validation: runBacktestValidationSuite(candles, benchmarkCandles, { ...options, symbol }),
  }));
  const common = {
    expectedSymbols,
    minimumReturn: Number(options.minimumPortfolioReturn ?? 0),
    minimumExcess: Number(options.minimumPortfolioExcess ?? 0),
    maximumDrawdown: Number(options.maximumPortfolioDrawdown ?? -0.10),
    minimumWinningBreadth: Number(options.minimumWinningBreadth ?? 0.40),
    minimumDataCoverage: Number(options.minimumDataCoverage ?? 0.95),
  };
  const fullSample = aggregatePeriod(validations, 'fullSample', {
    ...common,
    minimumTrades: Number(options.minimumPortfolioTrades ?? 25),
    minimumTradeCoverage: Number(options.minimumTradeCoverage ?? 0.20),
  });
  const recentHoldout = aggregatePeriod(validations, 'recentHoldout', {
    ...common,
    minimumTrades: Number(options.minimumPortfolioHoldoutTrades ?? 8),
    minimumTradeCoverage: Number(options.minimumHoldoutTradeCoverage ?? 0.10),
  });
  return {
    schemaVersion: 1,
    authority: 'PORTFOLIO_LEVEL_RESEARCH_ONLY',
    passed: fullSample.passed && recentHoldout.passed,
    expectedSymbols,
    evaluatedSymbols: validations.length,
    fullSample,
    recentHoldout,
  };
}

module.exports = {
  aggregateScenarioRows,
  runPortfolioValidationSuite,
  _test: { mean, aggregatePeriod },
};
