function monthlyCloses(candles) {
  const byMonth = new Map();
  for (const candle of candles || []) {
    const date = String(candle.date || '');
    const month = date.slice(0, 7);
    const close = Number(candle.adjustedClose ?? candle.close);
    if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(close) || close <= 0) continue;
    const current = byMonth.get(month);
    if (!current || date > current.date) byMonth.set(month, { month, date, close });
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxDrawdown(points) {
  let peak = 0;
  let worst = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) worst = Math.min(worst, point.equity / peak - 1);
  }
  return worst;
}

function alignedHistory(monthlyBySymbol) {
  const symbols = Object.keys(monthlyBySymbol || {}).sort();
  if (symbols.length === 0) throw new Error('EMPTY_ALLOCATION_UNIVERSE');
  const maps = Object.fromEntries(symbols.map((symbol) => [
    symbol,
    new Map((monthlyBySymbol[symbol] || []).map((row) => [row.month, Number(row.close)])),
  ]));
  const common = [...maps[symbols[0]].keys()]
    .filter((month) => symbols.every((symbol) => Number.isFinite(maps[symbol].get(month))))
    .sort();
  return { symbols, maps, common };
}

function driftWeights(targets, returns, portfolioReturn) {
  const denominator = 1 + portfolioReturn;
  return Object.fromEntries(Object.keys(targets).map((symbol) => [
    symbol,
    denominator > 0 ? targets[symbol] * (1 + returns[symbol]) / denominator : 0,
  ]));
}

function selectWithRetention(rankedSymbols, currentSelection, maxSelected, retentionRank) {
  const retained = currentSelection.filter((symbol) => {
    const rank = rankedSymbols.indexOf(symbol);
    return rank >= 0 && rank < retentionRank;
  });
  return [
    ...retained,
    ...rankedSymbols.filter((symbol) => !retained.includes(symbol)),
  ].slice(0, maxSelected);
}

function runMonthlyAllocation(monthlyBySymbol, options = {}) {
  const warmupMonths = Math.max(10, Number(options.warmupMonths || 10));
  const momentumMonths = Math.max(1, Number(options.momentumMonths || 6));
  const maxSelected = Math.max(1, Number(options.maxSelected || 3));
  const positionWeight = Number(options.positionWeight || 0.05);
  const rebalanceEveryMonths = Math.max(1, Number(options.rebalanceEveryMonths || 1));
  const retentionRank = Math.max(maxSelected, Number(options.retentionRank || maxSelected));
  const costRate = Number(options.costRate || 0);
  const { symbols, maps, common } = alignedHistory(monthlyBySymbol);
  const benchmarkGrossExposure = Math.min(1, maxSelected * positionWeight);
  const benchmarkPositionWeight = benchmarkGrossExposure / symbols.length;
  if (common.length < warmupMonths + 2) throw new Error('INSUFFICIENT_COMMON_MONTHS');
  const requestedStart = options.evaluationStartMonth
    ? common.findIndex((month) => month >= options.evaluationStartMonth)
    : warmupMonths;
  const startIndex = Math.max(warmupMonths, requestedStart < 0 ? common.length - 1 : requestedStart);
  if (common.length - startIndex < 2) throw new Error('INSUFFICIENT_EVALUATION_MONTHS');

  let equity = 1;
  let benchmarkEquity = 1;
  let weights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  let benchmarkWeights = Object.fromEntries(symbols.map((symbol) => [symbol, 0]));
  let positionChanges = 0;
  let rebalances = 0;
  let selected = [];
  const decisionLog = [];
  const curve = [{ month: common[startIndex], equity }];

  for (let index = startIndex; index < common.length - 1; index += 1) {
    const signalMonth = common[index];
    const returnMonth = common[index + 1];
    const isRebalance = (index - startIndex) % rebalanceEveryMonths === 0;
    let targets;
    if (isRebalance) {
      const ranked = symbols.flatMap((symbol) => {
        const current = maps[symbol].get(signalMonth);
        const priorTrend = common.slice(index - warmupMonths, index)
          .map((month) => maps[symbol].get(month));
        const momentumBase = maps[symbol].get(common[index - momentumMonths]);
        const momentum = current / momentumBase - 1;
        return current > mean(priorTrend) && momentum > 0 ? [{ symbol, momentum }] : [];
      }).sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
      const rankedSymbols = ranked.map((row) => row.symbol);
      selected = selectWithRetention(rankedSymbols, selected, maxSelected, retentionRank);
      targets = Object.fromEntries(symbols.map((symbol) => [
        symbol, selected.includes(symbol) ? positionWeight : 0,
      ]));
      rebalances += 1;
    } else {
      targets = { ...weights };
    }
    const turnover = symbols.reduce((sum, symbol) => sum + Math.abs(targets[symbol] - weights[symbol]), 0);
    if (turnover > 1e-12) positionChanges += 1;
    equity *= Math.max(0, 1 - turnover * costRate);

    const benchmarkTargets = isRebalance
      ? Object.fromEntries(symbols.map((symbol) => [symbol, benchmarkPositionWeight]))
      : { ...benchmarkWeights };
    const benchmarkTurnover = symbols.reduce(
      (sum, symbol) => sum + Math.abs(benchmarkTargets[symbol] - benchmarkWeights[symbol]), 0,
    );
    benchmarkEquity *= Math.max(0, 1 - benchmarkTurnover * costRate);
    const returns = Object.fromEntries(symbols.map((symbol) => [
      symbol, maps[symbol].get(returnMonth) / maps[symbol].get(signalMonth) - 1,
    ]));
    const portfolioReturn = symbols.reduce((sum, symbol) => sum + targets[symbol] * returns[symbol], 0);
    const benchmarkReturn = symbols.reduce(
      (sum, symbol) => sum + benchmarkTargets[symbol] * returns[symbol], 0,
    );
    equity *= 1 + portfolioReturn;
    benchmarkEquity *= 1 + benchmarkReturn;
    weights = driftWeights(targets, returns, portfolioReturn);
    benchmarkWeights = driftWeights(benchmarkTargets, returns, benchmarkReturn);
    decisionLog.push({ signalMonth, returnMonth, selected: [...selected], turnover, rebalanced: isRebalance });
    curve.push({ month: returnMonth, equity });
  }

  const totalReturn = equity - 1;
  const benchmarkReturn = benchmarkEquity - 1;
  return {
    strategy: 'DIVERSIFIED_MONTHLY_TREND_V1',
    startMonth: decisionLog[0]?.signalMonth || null,
    endMonth: decisionLog.at(-1)?.returnMonth || null,
    assumptions: {
      warmupMonths,
      momentumMonths,
      maxSelected,
      positionWeight,
      rebalanceEveryMonths,
      retentionRank,
      costRate,
      benchmarkGrossExposure,
      benchmarkPositionWeight,
    },
    metrics: {
      totalReturn,
      benchmarkReturn,
      excessVsBenchmark: totalReturn - benchmarkReturn,
      maxDrawdown: maxDrawdown(curve),
      decisions: decisionLog.length,
      positionChanges,
      rebalances,
    },
    decisionLog,
    equityCurve: curve,
  };
}

function gate(result, options = {}) {
  const minimumDecisions = Number(options.minimumDecisions || 12);
  const minimumPositionChanges = Number(options.minimumPositionChanges || 4);
  const maximumDrawdown = Number(options.maximumDrawdown || -0.10);
  const metrics = result.metrics;
  const checks = {
    positiveReturn: metrics.totalReturn > 0,
    positiveExcess: metrics.excessVsBenchmark > 0,
    drawdownControlled: metrics.maxDrawdown >= maximumDrawdown,
    enoughDecisions: metrics.decisions >= minimumDecisions,
    enoughPositionChanges: metrics.positionChanges >= minimumPositionChanges,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function runAllocationStressMatrix(monthlyBySymbol, options = {}) {
  const costs = options.costs || [0.00268, 0.005, 0.01];
  const { common } = alignedHistory(monthlyBySymbol);
  const holdoutMonths = Math.max(12, Number(options.holdoutMonths || 24));
  const holdoutStartMonth = common[Math.max(10, common.length - holdoutMonths - 1)];
  const run = (evaluationStartMonth) => costs.map((costRate) => {
    const result = runMonthlyAllocation(monthlyBySymbol, {
      ...options, costRate, evaluationStartMonth,
    });
    return { costRate, metrics: result.metrics, gate: gate(result, options), result };
  });
  const scenarios = run(null);
  const holdoutScenarios = run(holdoutStartMonth);
  return {
    schemaVersion: 1,
    strategy: 'DIVERSIFIED_MONTHLY_TREND_V1',
    passed: [...scenarios, ...holdoutScenarios].every((row) => row.gate.passed),
    scenarios,
    holdout: { startMonth: holdoutStartMonth, scenarios: holdoutScenarios },
  };
}

module.exports = {
  monthlyCloses,
  selectWithRetention,
  runMonthlyAllocation,
  runAllocationStressMatrix,
};
