const RULE_VERSION = 'MOMENTUM_BREAKOUT_V1.0.0';

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const output = new Array(values.length).fill(null);
  let current = mean(values.slice(0, period));
  output[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    output[index] = current;
  }
  return output;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return [];
  const output = new Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  output[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    avgGain = ((avgGain * (period - 1)) + Math.max(change, 0)) / period;
    avgLoss = ((avgLoss * (period - 1)) + Math.max(-change, 0)) / period;
    output[index] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return output;
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return [];
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  return ema(trueRanges, period);
}

function rollingMax(values, period, endExclusive) {
  const start = Math.max(0, endExclusive - period);
  const window = values.slice(start, endExclusive);
  return window.length > 0 ? Math.max(...window) : null;
}

function rollingMean(values, period, endExclusive) {
  const start = Math.max(0, endExclusive - period);
  return mean(values.slice(start, endExclusive));
}

function validateCandles(candles, options = {}) {
  const minimumBars = Number(options.minimumBars || 220);
  if (!Array.isArray(candles) || candles.length < minimumBars) {
    return { ok: false, reason: 'INSUFFICIENT_BARS', bars: Array.isArray(candles) ? candles.length : 0 };
  }
  let previousTime = 0;
  for (const candle of candles) {
    if (![candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)) {
      return { ok: false, reason: 'INVALID_OHLC' };
    }
    if (candle.high < candle.low || candle.high < candle.open || candle.high < candle.close) {
      return { ok: false, reason: 'IMPOSSIBLE_HIGH' };
    }
    if (candle.low > candle.open || candle.low > candle.close) return { ok: false, reason: 'IMPOSSIBLE_LOW' };
    if (Number(candle.time || 0) <= previousTime) return { ok: false, reason: 'NON_MONOTONIC_TIME' };
    previousTime = Number(candle.time || 0);
  }
  const latest = candles[candles.length - 1];
  const latestMs = Number(latest.time) * 1000;
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const maxAgeDays = Number(options.maxAgeDays || 7);
  if (!Number.isFinite(latestMs) || now - latestMs > maxAgeDays * 86400000) {
    return { ok: false, reason: 'STALE_DAILY_DATA', latestDate: latest.date || null };
  }
  return { ok: true, bars: candles.length, latestDate: latest.date || null };
}

function evaluateBenchmarkRegime(benchmarkCandles, options = {}) {
  const quality = validateCandles(benchmarkCandles, {
    minimumBars: Number(options.minimumBars || 220),
    maxAgeDays: Number(options.maxAgeDays || 7),
    now: options.now,
  });
  if (!quality.ok) return { tradable: false, reason: `BENCHMARK_${quality.reason}`, quality };
  const closes = benchmarkCandles.map((item) => item.adjustedClose || item.close);
  const ema200 = ema(closes, 200);
  const lastIndex = closes.length - 1;
  const current = closes[lastIndex];
  const longTrend = ema200[lastIndex];
  return {
    tradable: Number.isFinite(longTrend) && current > longTrend,
    reason: current > longTrend ? 'BENCHMARK_ABOVE_EMA200' : 'BENCHMARK_BELOW_EMA200',
    current,
    ema200: longTrend,
    quality,
  };
}

function evaluateActiveStrategy(candles, options = {}) {
  const quality = validateCandles(candles, options);
  if (!quality.ok) {
    return {
      ruleVersion: RULE_VERSION,
      action: 'NO_TRADE',
      reasonCodes: [quality.reason],
      quality,
      strategyAuthority: 'RULES_ONLY',
    };
  }

  const closes = candles.map((item) => item.adjustedClose || item.close);
  const volumes = candles.map((item) => Number(item.volume || 0));
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const index = candles.length - 1;
  const candle = candles[index];
  const close = closes[index];
  const priorHigh20 = rollingMax(candles.map((item) => item.high), 20, index);
  const averageVolume20 = rollingMean(volumes, 20, index);
  const volumeRatio = averageVolume20 > 0 ? volumes[index] / averageVolume20 : 0;
  const extensionAtr = Number.isFinite(atr14[index]) && atr14[index] > 0
    ? (close - ema20[index]) / atr14[index]
    : null;

  const features = {
    date: candle.date,
    close,
    ema20: ema20[index],
    ema50: ema50[index],
    rsi14: rsi14[index],
    atr14: atr14[index],
    priorHigh20,
    averageVolume20,
    volumeRatio,
    extensionAtr,
  };

  const reasons = [];
  const benchmark = options.benchmarkRegime || { tradable: false, reason: 'BENCHMARK_REQUIRED' };
  if (!benchmark.tradable) reasons.push(benchmark.reason || 'BENCHMARK_NOT_TRADABLE');
  if (!(close > ema20[index] && ema20[index] > ema50[index])) reasons.push('TREND_FILTER_FAILED');
  if (!(Number.isFinite(priorHigh20) && close > priorHigh20)) reasons.push('NO_20D_BREAKOUT');
  if (!(volumeRatio >= Number(options.minimumVolumeRatio || 1.2))) reasons.push('VOLUME_CONFIRMATION_FAILED');
  if (!(rsi14[index] >= Number(options.minimumRsi || 55) && rsi14[index] <= Number(options.maximumRsi || 75))) {
    reasons.push('RSI_OUTSIDE_RANGE');
  }
  if (!(Number.isFinite(extensionAtr) && extensionAtr <= Number(options.maximumExtensionAtr || 2.5))) {
    reasons.push('PRICE_TOO_EXTENDED');
  }

  if (reasons.length === 0) {
    return {
      ruleVersion: RULE_VERSION,
      action: 'BUY_CANDIDATE',
      reasonCodes: [
        'BENCHMARK_REGIME_OK',
        'EMA20_ABOVE_EMA50',
        'BREAKOUT_ABOVE_PRIOR_20D_HIGH',
        'VOLUME_CONFIRMED',
        'RSI_CONFIRMED',
      ],
      features,
      quality,
      strategyAuthority: 'RULES_ONLY',
    };
  }

  const exitReasons = [];
  if (close < ema20[index]) exitReasons.push('CLOSE_BELOW_EMA20');
  if (Number.isFinite(atr14[index])) {
    const highestClose20 = rollingMax(closes, 20, index + 1);
    const trailingStop = highestClose20 - (2 * atr14[index]);
    features.trailingStop = trailingStop;
    if (close < trailingStop) exitReasons.push('ATR_TRAILING_STOP_BROKEN');
  }

  if (options.hasPosition && exitReasons.length > 0) {
    return {
      ruleVersion: RULE_VERSION,
      action: 'EXIT_REVIEW',
      reasonCodes: exitReasons,
      features,
      quality,
      strategyAuthority: 'RULES_ONLY',
    };
  }

  return {
    ruleVersion: RULE_VERSION,
    action: options.hasPosition ? 'HOLD' : 'NO_TRADE',
    reasonCodes: reasons,
    features,
    quality,
    strategyAuthority: 'RULES_ONLY',
  };
}

module.exports = {
  RULE_VERSION,
  evaluateActiveStrategy,
  evaluateBenchmarkRegime,
  validateCandles,
  indicators: { mean, ema, rsi, atr, rollingMax, rollingMean },
};
