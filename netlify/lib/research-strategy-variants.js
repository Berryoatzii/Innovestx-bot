const {
  validateCandles,
  indicators: { ema, rsi, atr, rollingMax, rollingMean },
} = require('./deterministic-strategy');

function rollingMin(values, period, endExclusive) {
  const start = Math.max(0, endExclusive - period);
  const window = values.slice(start, endExclusive);
  return window.length > 0 ? Math.min(...window) : null;
}

const VARIANTS = Object.freeze({
  TURTLE_55_20_V1: Object.freeze({
    id: 'TURTLE_55_20_V1',
    entryHighDays: 55,
    exitLowDays: 20,
    trendEmaDays: 200,
    minimumVolumeRatio: 0,
    minimumRsi: 0,
    maximumRsi: 100,
    maximumExtensionAtr: Infinity,
    trailingAtrMultiple: null,
  }),
  DUAL_TREND_BREAKOUT_V1: Object.freeze({
    id: 'DUAL_TREND_BREAKOUT_V1',
    entryHighDays: 20,
    exitLowDays: null,
    trendEmaDays: 200,
    fastEmaDays: 50,
    minimumVolumeRatio: 1.0,
    minimumRsi: 50,
    maximumRsi: 85,
    maximumExtensionAtr: 4,
    trailingAtrMultiple: 3,
  }),
});

const BENCHMARK_VARIANTS = Object.freeze({
  ADAPTIVE_TREND_V1: Object.freeze({
    id: 'ADAPTIVE_TREND_V1',
    longEmaDays: 200,
    recoveryEmaDays: 50,
    recoverySlopeLookback: 20,
  }),
});

function evaluateAdaptiveBenchmark(benchmarkCandles, options = {}, variant = BENCHMARK_VARIANTS.ADAPTIVE_TREND_V1) {
  const quality = validateCandles(benchmarkCandles, {
    minimumBars: Number(options.minimumBars || 220),
    maxAgeDays: Number(options.maxAgeDays || 7),
    now: options.now,
  });
  if (!quality.ok) return { tradable: false, reason: `BENCHMARK_${quality.reason}`, quality, ruleVersion: variant.id };
  const closes = benchmarkCandles.map((item) => item.close);
  const longEma = ema(closes, variant.longEmaDays);
  const recoveryEma = ema(closes, variant.recoveryEmaDays);
  const index = closes.length - 1;
  const slopeIndex = index - variant.recoverySlopeLookback;
  const longTrend = closes[index] > longEma[index];
  const recoveryTrend = slopeIndex >= 0
    && closes[index] > recoveryEma[index]
    && recoveryEma[index] > recoveryEma[slopeIndex];
  const tradable = Boolean(longTrend || recoveryTrend);
  return {
    tradable,
    reason: longTrend
      ? 'BENCHMARK_ABOVE_EMA200'
      : recoveryTrend
        ? 'BENCHMARK_RECOVERY_TREND'
        : 'BENCHMARK_TREND_NOT_CONFIRMED',
    current: closes[index],
    longEma: longEma[index],
    recoveryEma: recoveryEma[index],
    recoverySlope: slopeIndex >= 0 ? recoveryEma[index] - recoveryEma[slopeIndex] : null,
    quality,
    ruleVersion: variant.id,
  };
}

function evaluateVariant(candles, options = {}, variant) {
  const quality = validateCandles(candles, options);
  if (!quality.ok) {
    return {
      ruleVersion: variant.id,
      action: 'NO_TRADE',
      reasonCodes: [quality.reason],
      quality,
      strategyAuthority: 'RESEARCH_ONLY',
    };
  }

  const closes = candles.map((item) => item.close);
  const lows = candles.map((item) => item.low);
  const highs = candles.map((item) => item.high);
  const volumes = candles.map((item) => Number(item.volume || 0));
  const longEma = ema(closes, variant.trendEmaDays);
  const fastEma = variant.fastEmaDays ? ema(closes, variant.fastEmaDays) : null;
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const index = candles.length - 1;
  const close = closes[index];
  const priorHigh = rollingMax(highs, variant.entryHighDays, index);
  const priorExitLow = variant.exitLowDays ? rollingMin(lows, variant.exitLowDays, index) : null;
  const averageVolume20 = rollingMean(volumes, 20, index);
  const volumeRatio = averageVolume20 > 0 ? volumes[index] / averageVolume20 : 0;
  const extensionAtr = Number.isFinite(atr14[index]) && atr14[index] > 0 && fastEma
    ? (close - fastEma[index]) / atr14[index]
    : 0;
  const highestClose20 = rollingMax(closes, 20, index + 1);
  const trailingStop = variant.trailingAtrMultiple && Number.isFinite(atr14[index])
    ? highestClose20 - (variant.trailingAtrMultiple * atr14[index])
    : null;
  const benchmark = options.benchmarkRegime || { tradable: false, reason: 'BENCHMARK_REQUIRED' };
  const features = {
    date: candles[index].date,
    close,
    longEma: longEma[index],
    fastEma: fastEma?.[index] ?? null,
    priorHigh,
    priorExitLow,
    volumeRatio,
    rsi14: rsi14[index],
    atr14: atr14[index],
    extensionAtr,
    trailingStop,
  };

  const reasons = [];
  if (!benchmark.tradable) reasons.push(benchmark.reason || 'BENCHMARK_NOT_TRADABLE');
  if (!(close > longEma[index])) reasons.push('LONG_TREND_FILTER_FAILED');
  if (fastEma && !(fastEma[index] > longEma[index] && close > fastEma[index])) reasons.push('DUAL_TREND_FILTER_FAILED');
  if (!(Number.isFinite(priorHigh) && close > priorHigh)) reasons.push('BREAKOUT_FILTER_FAILED');
  if (!(volumeRatio >= variant.minimumVolumeRatio)) reasons.push('VOLUME_FILTER_FAILED');
  if (!(rsi14[index] >= variant.minimumRsi && rsi14[index] <= variant.maximumRsi)) reasons.push('RSI_FILTER_FAILED');
  if (!(extensionAtr <= variant.maximumExtensionAtr)) reasons.push('EXTENSION_FILTER_FAILED');

  if (reasons.length === 0) {
    return {
      ruleVersion: variant.id,
      action: 'BUY_CANDIDATE',
      reasonCodes: ['BENCHMARK_REGIME_OK', 'LONG_TREND_OK', 'BREAKOUT_CONFIRMED'],
      features,
      quality,
      strategyAuthority: 'RESEARCH_ONLY',
    };
  }

  const exitReasons = [];
  if (variant.exitLowDays && Number.isFinite(priorExitLow) && close < priorExitLow) {
    exitReasons.push('CLOSE_BELOW_EXIT_LOW');
  }
  if (fastEma && close < fastEma[index]) exitReasons.push('CLOSE_BELOW_FAST_EMA');
  if (Number.isFinite(trailingStop) && close < trailingStop) exitReasons.push('ATR_TRAILING_STOP_BROKEN');

  return {
    ruleVersion: variant.id,
    action: options.hasPosition && exitReasons.length > 0 ? 'EXIT_REVIEW' : options.hasPosition ? 'HOLD' : 'NO_TRADE',
    reasonCodes: options.hasPosition && exitReasons.length > 0 ? exitReasons : reasons,
    features,
    quality,
    strategyAuthority: 'RESEARCH_ONLY',
  };
}

function evaluatorFor(id) {
  const variant = VARIANTS[id];
  if (!variant) throw new Error(`UNKNOWN_RESEARCH_VARIANT:${id}`);
  return (candles, options = {}) => evaluateVariant(candles, options, variant);
}

function benchmarkEvaluatorFor(id) {
  const variant = BENCHMARK_VARIANTS[id];
  if (!variant) throw new Error(`UNKNOWN_BENCHMARK_VARIANT:${id}`);
  return (candles, options = {}) => evaluateAdaptiveBenchmark(candles, options, variant);
}

module.exports = {
  VARIANTS,
  BENCHMARK_VARIANTS,
  evaluatorFor,
  benchmarkEvaluatorFor,
  _test: { rollingMin, evaluateVariant, evaluateAdaptiveBenchmark },
};
