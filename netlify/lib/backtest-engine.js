const { evaluateActiveStrategy, evaluateBenchmarkRegime } = require('./deterministic-strategy');
const { loadCostModel, transactionCost } = require('./cost-model');

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
  const warmupBars = Math.max(220, Number(options.warmupBars || 220));
  const alignedBenchmark = alignBenchmark(stockCandles, benchmarkCandles);

  let cash = initialCapital;
  let quantity = 0;
  let entryPrice = 0;
  let entryDate = null;
  let totalTurnover = 0;
  const trades = [];
  const equityCurve = [];
  const decisionLog = [];

  for (let index = warmupBars; index < stockCandles.length - 1; index += 1) {
    const history = stockCandles.slice(0, index + 1);
    const benchmarkHistory = alignedBenchmark.slice(0, index + 1).filter(Boolean);
    const benchmarkRegime = evaluateBenchmarkRegime(benchmarkHistory, {
      minimumBars: 220,
      maxAgeDays: 99999,
      now: new Date((stockCandles[index].time + 86400) * 1000),
    });
    const signal = evaluateActiveStrategy(history, {
      minimumBars: 220,
      maxAgeDays: 99999,
      now: new Date((stockCandles[index].time + 86400) * 1000),
      hasPosition: quantity > 0,
      benchmarkRegime,
    });
    const next = stockCandles[index + 1];
    const markPrice = stockCandles[index].close;

    decisionLog.push({
      date: stockCandles[index].date,
      action: signal.action,
      reasonCodes: signal.reasonCodes,
      close: markPrice,
      positionQty: quantity,
    });

    if (quantity === 0 && signal.action === 'BUY_CANDIDATE') {
      const executionPrice = Number(next.open || next.close);
      const maxNotional = Math.min(cash, initialCapital * maxPositionWeight);
      const proposedQty = Math.floor((maxNotional / executionPrice) / boardLot) * boardLot;
      if (proposedQty > 0) {
        const notional = proposedQty * executionPrice;
        const costs = transactionCost(notional, costModel);
        if (notional + costs.total <= cash) {
          cash -= notional + costs.total;
          quantity = proposedQty;
          entryPrice = executionPrice;
          entryDate = next.date;
          totalTurnover += notional;
          trades.push({
            symbol: options.symbol || null,
            side: 'BUY',
            signalDate: stockCandles[index].date,
            executionDate: next.date,
            price: executionPrice,
            quantity: proposedQty,
            notional,
            costs: costs.total,
            ruleVersion: signal.ruleVersion,
            reasonCodes: signal.reasonCodes,
          });
        }
      }
    } else if (quantity > 0 && signal.action === 'EXIT_REVIEW') {
      const executionPrice = Number(next.open || next.close);
      const notional = quantity * executionPrice;
      const costs = transactionCost(notional, costModel);
      const grossPnl = (executionPrice - entryPrice) * quantity;
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
        price: executionPrice,
        quantity,
        notional,
        costs: costs.total,
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
    const notional = quantity * last.close;
    const costs = transactionCost(notional, costModel);
    const grossPnl = (last.close - entryPrice) * quantity;
    const matchingBuy = [...trades].reverse().find((trade) => trade.side === 'BUY' && !trade.closed);
    const entryCosts = matchingBuy ? matchingBuy.costs : 0;
    cash += notional - costs.total;
    totalTurnover += notional;
    trades.push({
      symbol: options.symbol || null,
      side: 'SELL',
      signalDate: last.date,
      executionDate: last.date,
      price: last.close,
      quantity,
      notional,
      costs: costs.total,
      grossPnl,
      netPnl: grossPnl - entryCosts - costs.total,
      entryDate,
      forcedResearchClose: true,
      ruleVersion: 'RESEARCH_END_CLOSE',
      reasonCodes: ['END_OF_BACKTEST'],
    });
    quantity = 0;
  }

  const finalEquity = cash;
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

  const firstBenchmark = alignedBenchmark.slice(warmupBars).find(Boolean);
  const lastBenchmark = [...alignedBenchmark].reverse().find(Boolean);
  const benchmarkReturn = firstBenchmark && lastBenchmark
    ? (Number(lastBenchmark.adjustedClose || lastBenchmark.close) / Number(firstBenchmark.adjustedClose || firstBenchmark.close)) - 1
    : null;

  return {
    strategy: 'MOMENTUM_BREAKOUT_V1',
    symbol: options.symbol || null,
    startDate: stockCandles[warmupBars]?.date || null,
    endDate: last?.date || null,
    assumptions: {
      nextBarExecution: true,
      initialCapital,
      maxPositionWeight,
      boardLot,
      costModel,
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
      benchmarkReturn,
      excessVsBenchmark: benchmarkReturn == null ? null : finalEquity / initialCapital - 1 - benchmarkReturn,
      excessVsCash: finalEquity / initialCapital - 1,
    },
    trades,
    equityCurve,
    decisionLog,
  };
}

module.exports = {
  backtestActiveStrategy,
  metrics: { annualizedReturn, standardDeviation, maxDrawdown },
};
