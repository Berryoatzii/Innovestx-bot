const { evaluateActiveStrategy, evaluateBenchmarkRegime } = require('./deterministic-strategy');
const { loadCostModel } = require('./cost-model');
const { simulateDailyExecution } = require('./execution-realism');

function annualizedReturn(startValue, endValue, tradingDays) {
  if (startValue <= 0 || endValue <= 0 || tradingDays <= 0) return 0;
  return Math.pow(endValue / startValue, 252 / tradingDays) - 1;
}

function standardDeviation(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdown(equityCurve) {
  let peak = -Infinity;
  let worst = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) worst = Math.min(worst, point.equity / peak - 1);
  }
  return worst;
}

function alignBenchmark(stockCandles, benchmarkCandles) {
  const map = new Map((benchmarkCandles || []).map((item) => [item.date, item]));
  return stockCandles.map((item) => map.get(item.date) || null);
}

function backtestActiveStrategy(stockCandles, benchmarkCandles, options = {}) {
  const initialCapital = Number(options.initialCapital || 100000);
  const maxPositionWeight = Number(options.maxPositionWeight || 0.10);
  const boardLot = Math.max(1, Math.floor(Number(options.boardLot || 100)));
  const costModel = options.costModel || loadCostModel();
  const maxParticipationRate = Number(options.maxParticipationRate ?? 0.01);
  const impactBpsAtMaxParticipation = Number(options.impactBpsAtMaxParticipation ?? 25);
  const signalEvaluator = options.signalEvaluator || evaluateActiveStrategy;
  const benchmarkEvaluator = options.benchmarkEvaluator || evaluateBenchmarkRegime;
  const warmupBars = Math.max(220, Number(options.warmupBars || 220));
  const alignedBenchmark = alignBenchmark(stockCandles, benchmarkCandles);
  const requestedStartIndex = options.evaluationStartDate
    ? stockCandles.findIndex((candle) => String(candle.date || '') >= String(options.evaluationStartDate))
    : warmupBars;
  const evaluationStartIndex = Math.max(
    warmupBars,
    requestedStartIndex >= 0 ? requestedStartIndex : stockCandles.length - 1
  );

  let cash = initialCapital;
  let quantity = 0;
  let entryPrice = 0;
  let entryDate = null;
  let totalTurnover = 0;
  const trades = [];
  const equityCurve = [];
  const decisionLog = [];
  let liquidityRejectedOrders = 0;
  let executionRejectedOrders = 0;

  for (let index = evaluationStartIndex; index < stockCandles.length - 1; index += 1) {
    const history = stockCandles.slice(0, index + 1);
    const benchmarkHistory = alignedBenchmark.slice(0, index + 1).filter(Boolean);
    const benchmarkRegime = benchmarkEvaluator(benchmarkHistory, {
      minimumBars: 220,
      maxAgeDays: 99999,
      now: new Date((stockCandles[index].time + 86400) * 1000),
    });
    const signal = signalEvaluator(history, {
      minimumBars: 220,
      maxAgeDays: 99999,
      now: new Date((stockCandles[index].time + 86400) * 1000),
      hasPosition: quantity > 0,
      benchmarkRegime,
    });
    const next = stockCandles[index + 1];
    const markPrice = stockCandles[index].close;

    const decision = {
      date: stockCandles[index].date,
      action: signal.action,
      reasonCodes: signal.reasonCodes,
      close: markPrice,
      positionQty: quantity,
    };
    decisionLog.push(decision);

    if (quantity === 0 && signal.action === 'BUY_CANDIDATE') {
      const executionPrice = Number(next.open || next.close);
      const maxNotional = Math.min(cash, initialCapital * maxPositionWeight);
      const proposedQty = Math.floor((maxNotional / executionPrice) / boardLot) * boardLot;
      if (proposedQty > 0) {
        const execution = simulateDailyExecution({
          side: 'BUY',
          requestedQuantity: proposedQty,
          referencePrice: executionPrice,
          dailyVolume: next.volume,
          boardLot,
          maxParticipationRate,
          impactBpsAtMaxParticipation,
          costModel,
        });
        decision.executionReason = execution.reason;
        if (!execution.filled) {
          executionRejectedOrders += 1;
          if (execution.reason === 'LIQUIDITY_LIMIT') liquidityRejectedOrders += 1;
        } else if (execution.notional + execution.costs.total <= cash) {
          cash -= execution.notional + execution.costs.total;
          quantity = proposedQty;
          entryPrice = execution.price;
          entryDate = next.date;
          totalTurnover += execution.notional;
          trades.push({
            symbol: options.symbol || null,
            side: 'BUY',
            signalDate: stockCandles[index].date,
            executionDate: next.date,
            price: execution.price,
            quantity: proposedQty,
            notional: execution.notional,
            costs: execution.costs.total,
            marketImpact: execution.costs.marketImpact,
            participationRate: execution.participationRate,
            ruleVersion: signal.ruleVersion,
            reasonCodes: signal.reasonCodes,
          });
        }
      }
    } else if (quantity > 0 && signal.action === 'EXIT_REVIEW') {
      const executionPrice = Number(next.open || next.close);
      const execution = simulateDailyExecution({
        side: 'SELL',
        requestedQuantity: quantity,
        referencePrice: executionPrice,
        dailyVolume: next.volume,
        boardLot,
        maxParticipationRate,
        impactBpsAtMaxParticipation,
        costModel,
      });
      decision.executionReason = execution.reason;
      if (!execution.filled) {
        executionRejectedOrders += 1;
        if (execution.reason === 'LIQUIDITY_LIMIT') liquidityRejectedOrders += 1;
        continue;
      }
      const notional = execution.notional;
      const costs = execution.costs;
      const grossPnl = (execution.price - entryPrice) * quantity;
      const matchingBuy = [...trades].reverse().find((trade) => trade.side === 'BUY' && !trade.closed);
      const entryCosts = matchingBuy ? matchingBuy.costs : 0;
      const netPnl = grossPnl - entryCosts - costs.total;
      cash += notional - costs.total;
      totalTurnover += notional;
      trades.push({
        symbol: options.symbol || null,
        side: 'SELL',
        signalDate: stockCandles[index].date,
        executionDate: next.date,
        price: execution.price,
        quantity,
        notional,
        costs: costs.total,
        marketImpact: costs.marketImpact,
        participationRate: execution.participationRate,
        grossPnl,
        netPnl,
        entryDate,
        holdingDays: Math.max(1, Math.round((new Date(next.date) - new Date(entryDate)) / 86400000)),
        ruleVersion: signal.ruleVersion,
        reasonCodes: signal.reasonCodes,
      });
      if (matchingBuy) matchingBuy.closed = true;
      quantity = 0;
      entryPrice = 0;
      entryDate = null;
    }

    equityCurve.push({
      date: stockCandles[index].date,
      equity: cash + quantity * markPrice,
      cash,
      positionValue: quantity * markPrice,
      quantity,
    });
  }

  const last = stockCandles[stockCandles.length - 1];
  if (quantity > 0) {
    const execution = simulateDailyExecution({
      side: 'SELL', requestedQuantity: quantity, referencePrice: last.close,
      dailyVolume: last.volume, boardLot, maxParticipationRate,
      impactBpsAtMaxParticipation, costModel,
    });
    if (execution.filled) {
      const matchingBuy = [...trades].reverse().find((trade) => trade.side === 'BUY' && !trade.closed);
      const entryCosts = matchingBuy ? matchingBuy.costs : 0;
      const grossPnl = (execution.price - entryPrice) * quantity;
      cash += execution.notional - execution.costs.total;
      totalTurnover += execution.notional;
      trades.push({
        symbol: options.symbol || null,
        side: 'SELL',
        signalDate: last.date,
        executionDate: last.date,
        price: execution.price,
        quantity,
        notional: execution.notional,
        costs: execution.costs.total,
        marketImpact: execution.costs.marketImpact,
        participationRate: execution.participationRate,
        grossPnl,
        netPnl: grossPnl - entryCosts - execution.costs.total,
        entryDate,
        forcedResearchClose: true,
        ruleVersion: 'RESEARCH_END_CLOSE',
        reasonCodes: ['END_OF_BACKTEST'],
      });
      quantity = 0;
    } else {
      executionRejectedOrders += 1;
      if (execution.reason === 'LIQUIDITY_LIMIT') liquidityRejectedOrders += 1;
    }
  }

  const finalEquity = cash + quantity * Number(last?.close || 0);
  const dailyReturns = [];
  for (let index = 1; index < equityCurve.length; index += 1) {
    const previous = equityCurve[index - 1].equity;
    const current = equityCurve[index].equity;
    if (previous > 0) dailyReturns.push(current / previous - 1);
  }
  const volatility = standardDeviation(dailyReturns) * Math.sqrt(252);
  const averageDaily = dailyReturns.length > 0
    ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
    : 0;
  const downside = standardDeviation(dailyReturns.filter((value) => value < 0));
  const completedTrades = trades.filter((trade) => trade.side === 'SELL');
  const winners = completedTrades.filter((trade) => Number(trade.netPnl || 0) > 0);
  const losers = completedTrades.filter((trade) => Number(trade.netPnl || 0) < 0);
  const averageWin = winners.length > 0 ? winners.reduce((sum, item) => sum + item.netPnl, 0) / winners.length : 0;
  const averageLoss = losers.length > 0 ? Math.abs(losers.reduce((sum, item) => sum + item.netPnl, 0) / losers.length) : 0;

  const firstBenchmark = alignedBenchmark.slice(evaluationStartIndex).find(Boolean);
  const lastBenchmark = [...alignedBenchmark].reverse().find(Boolean);
  const benchmarkReturn = firstBenchmark && lastBenchmark
    ? (Number(lastBenchmark.close) / Number(firstBenchmark.close)) - 1
    : null;
  const benchmarkPortfolioReturn = benchmarkReturn == null ? null : benchmarkReturn * maxPositionWeight;

  return {
    strategy: 'MOMENTUM_BREAKOUT_V1',
    symbol: options.symbol || null,
    startDate: stockCandles[evaluationStartIndex]?.date || null,
    endDate: last?.date || null,
    assumptions: {
      nextBarExecution: true,
      initialCapital,
      maxPositionWeight,
      boardLot,
      costModel,
      maxParticipationRate,
      impactBpsAtMaxParticipation,
      benchmark: options.benchmark || 'SET_INDEX_PROXY',
      cashReturn: 0,
    },
    metrics: {
      finalEquity,
      totalReturn: finalEquity / initialCapital - 1,
      cagr: annualizedReturn(initialCapital, finalEquity, Math.max(1, equityCurve.length)),
      annualizedVolatility: volatility,
      sharpeZeroRate: volatility > 0 ? (averageDaily * 252) / volatility : 0,
      sortinoZeroRate: downside > 0 ? (averageDaily * 252) / (downside * Math.sqrt(252)) : 0,
      maxDrawdown: maxDrawdown(equityCurve),
      completedTrades: completedTrades.length,
      winRate: completedTrades.length > 0 ? winners.length / completedTrades.length : 0,
      payoffRatio: averageLoss > 0 ? averageWin / averageLoss : null,
      turnover: initialCapital > 0 ? totalTurnover / initialCapital : 0,
      executionRejectedOrders,
      liquidityRejectedOrders,
      openPositionAtEnd: quantity > 0,
      benchmarkReturn,
      benchmarkPortfolioReturn,
      excessVsBenchmark: benchmarkPortfolioReturn == null
        ? null
        : finalEquity / initialCapital - 1 - benchmarkPortfolioReturn,
      excessVsCash: finalEquity / initialCapital - 1,
    },
    trades,
    equityCurve,
    decisionLog,
  };
}

function runBacktestStressMatrix(stockCandles, benchmarkCandles, options = {}) {
  const baseCostModel = options.costModel || loadCostModel();
  const baseParticipation = Number(options.maxParticipationRate ?? 0.01);
  const scenarios = [
    {
      id: 'BASE',
      costModel: baseCostModel,
      maxParticipationRate: baseParticipation,
      impactBpsAtMaxParticipation: Number(options.impactBpsAtMaxParticipation ?? 25),
    },
    {
      id: 'HIGH_FRICTION',
      costModel: { ...baseCostModel, slippageBpsPerSide: Math.max(25, Number(baseCostModel.slippageBpsPerSide || 0)) },
      maxParticipationRate: Math.min(baseParticipation, 0.005),
      impactBpsAtMaxParticipation: Math.max(50, Number(options.impactBpsAtMaxParticipation || 0)),
    },
    {
      id: 'SEVERE_FRICTION',
      costModel: { ...baseCostModel, slippageBpsPerSide: Math.max(50, Number(baseCostModel.slippageBpsPerSide || 0)) },
      maxParticipationRate: Math.min(baseParticipation, 0.0025),
      impactBpsAtMaxParticipation: Math.max(100, Number(options.impactBpsAtMaxParticipation || 0)),
    },
  ].map((scenario) => {
    const result = backtestActiveStrategy(stockCandles, benchmarkCandles, {
      ...options,
      costModel: scenario.costModel,
      maxParticipationRate: scenario.maxParticipationRate,
      impactBpsAtMaxParticipation: scenario.impactBpsAtMaxParticipation,
    });
    return {
      id: scenario.id,
      assumptions: {
        costModel: scenario.costModel,
        maxParticipationRate: scenario.maxParticipationRate,
        impactBpsAtMaxParticipation: scenario.impactBpsAtMaxParticipation,
      },
      metrics: result.metrics,
      result,
    };
  });

  const minimumStressTrades = Math.max(1, Number(options.minimumStressTrades ?? 5));
  const minimumStressReturn = Number(options.minimumStressReturn ?? 0);
  const maximumStressDrawdown = Number(options.maximumStressDrawdown ?? -0.25);
  const checks = scenarios.map((scenario) => ({
    id: scenario.id,
    finite: [scenario.metrics.totalReturn, scenario.metrics.maxDrawdown, scenario.metrics.cagr]
      .every((value) => Number.isFinite(Number(value))),
    enoughTrades: Number(scenario.metrics.completedTrades || 0) >= minimumStressTrades,
    returnPassed: Number(scenario.metrics.totalReturn || 0) > minimumStressReturn,
    drawdownPassed: Number(scenario.metrics.maxDrawdown || 0) >= maximumStressDrawdown,
    noLiquidityRejections: Number(scenario.metrics.liquidityRejectedOrders || 0) === 0,
  }));
  const passed = checks.every((check) =>
    check.finite && check.enoughTrades && check.returnPassed && check.drawdownPassed && check.noLiquidityRejections
  );

  return {
    schemaVersion: 1,
    passed,
    requirements: { minimumStressTrades, minimumStressReturn, maximumStressDrawdown },
    checks,
    scenarios,
    baseline: scenarios[0].result,
    worstTotalReturn: Math.min(...scenarios.map((row) => Number(row.metrics.totalReturn || 0))),
    worstDrawdown: Math.min(...scenarios.map((row) => Number(row.metrics.maxDrawdown || 0))),
  };
}

function runBacktestValidationSuite(stockCandles, benchmarkCandles, options = {}) {
  const warmupBars = Math.max(220, Number(options.warmupBars || 220));
  const oosBars = Math.max(1, Math.floor(Number(options.oosBars ?? 504)));
  const holdoutIndex = Math.max(warmupBars, stockCandles.length - oosBars);
  const startDate = stockCandles[holdoutIndex]?.date || null;
  const fullSample = runBacktestStressMatrix(stockCandles, benchmarkCandles, options);
  const recentHoldout = runBacktestStressMatrix(stockCandles, benchmarkCandles, {
    ...options,
    evaluationStartDate: startDate,
    minimumStressTrades: Number(options.minimumHoldoutTrades ?? 3),
  });
  return {
    schemaVersion: 1,
    passed: fullSample.passed && recentHoldout.passed,
    oosBars,
    fullSample,
    recentHoldout: { ...recentHoldout, startDate },
  };
}

module.exports = {
  backtestActiveStrategy,
  runBacktestStressMatrix,
  runBacktestValidationSuite,
  metrics: { annualizedReturn, standardDeviation, maxDrawdown },
};
