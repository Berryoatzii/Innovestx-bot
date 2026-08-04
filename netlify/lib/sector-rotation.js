const { fetchDailyHistory } = require('./research-market-data');
const { indicators } = require('./deterministic-strategy');

const ROTATION_VERSION = 'SECTOR_ROTATION_V1.0.0';
const BENCHMARK = { ticker: 'SPY', name: 'S&P 500 ETF' };
const US_SECTORS = [
  { ticker: 'XLC', name: 'Communication Services' },
  { ticker: 'XLY', name: 'Consumer Discretionary' },
  { ticker: 'XLP', name: 'Consumer Staples' },
  { ticker: 'XLE', name: 'Energy' },
  { ticker: 'XLF', name: 'Financials' },
  { ticker: 'XLV', name: 'Health Care' },
  { ticker: 'XLI', name: 'Industrials' },
  { ticker: 'XLB', name: 'Materials' },
  { ticker: 'XLRE', name: 'Real Estate' },
  { ticker: 'XLK', name: 'Technology' },
  { ticker: 'XLU', name: 'Utilities' },
];

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length === 0) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function standardDeviation(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return null;
  const average = mean(clean);
  return Math.sqrt(clean.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / clean.length);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function isoWeekKey(dateText) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function toWeekly(candles) {
  const byWeek = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const key = isoWeekKey(candle.date);
    if (!key) continue;
    const existing = byWeek.get(key);
    const row = {
      week: key,
      date: candle.date,
      close: finite(candle.adjustedClose || candle.close),
      volume: finite(candle.volume, 0),
    };
    if (!(row.close > 0)) continue;
    if (!existing || row.date > existing.date) byWeek.set(key, row);
    else existing.volume += row.volume;
  }
  return [...byWeek.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function alignWeekly(assetWeekly, benchmarkWeekly) {
  const benchmarkMap = new Map(benchmarkWeekly.map((row) => [row.week, row]));
  return assetWeekly
    .filter((row) => benchmarkMap.has(row.week))
    .map((row) => ({
      week: row.week,
      date: row.date,
      assetClose: row.close,
      benchmarkClose: benchmarkMap.get(row.week).close,
      volume: row.volume,
    }))
    .filter((row) => row.assetClose > 0 && row.benchmarkClose > 0);
}

function pctChange(values, lookback) {
  return values.map((value, index) => {
    if (index < lookback || !(values[index - lookback] > 0)) return null;
    return value / values[index - lookback] - 1;
  });
}

function rollingZScore(values, window) {
  return values.map((value, index) => {
    if (!Number.isFinite(value) || index + 1 < window) return null;
    const sample = values.slice(index - window + 1, index + 1).filter(Number.isFinite);
    if (sample.length < Math.max(8, Math.floor(window * 0.75))) return null;
    const average = mean(sample);
    const sd = standardDeviation(sample);
    if (!(sd > 0)) return 0;
    return (value - average) / sd;
  });
}

function scoreFromZ(z) {
  if (!Number.isFinite(z)) return null;
  return Number((100 + clamp(z, -3, 3) * 10).toFixed(2));
}

function quadrant(ratioScore, momentumScore) {
  if (!Number.isFinite(ratioScore) || !Number.isFinite(momentumScore)) return 'UNAVAILABLE';
  if (ratioScore >= 100 && momentumScore >= 100) return 'LEADING';
  if (ratioScore >= 100 && momentumScore < 100) return 'WEAKENING';
  if (ratioScore < 100 && momentumScore < 100) return 'LAGGING';
  return 'IMPROVING';
}

function periodReturn(values, lookback) {
  if (!Array.isArray(values) || values.length <= lookback) return null;
  const latest = values[values.length - 1];
  const prior = values[values.length - 1 - lookback];
  if (!(latest > 0 && prior > 0)) return null;
  return latest / prior - 1;
}

function latestFinite(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return values[index];
  }
  return null;
}

function averageVolumeRatio(weeklyRows) {
  if (weeklyRows.length < 16) return null;
  const volumes = weeklyRows.map((row) => Number(row.volume || 0));
  const recent = mean(volumes.slice(-4));
  const prior = mean(volumes.slice(-16, -4));
  if (!(recent >= 0 && prior > 0)) return null;
  return recent / prior;
}

function analyzeSector(assetHistory, benchmarkHistory, sector) {
  const assetWeekly = toWeekly(assetHistory.candles);
  const benchmarkWeekly = toWeekly(benchmarkHistory.candles);
  const aligned = alignWeekly(assetWeekly, benchmarkWeekly);
  if (aligned.length < 60) {
    return {
      ticker: sector.ticker,
      name: sector.name,
      available: false,
      reason: 'INSUFFICIENT_ALIGNED_WEEKS',
      weeks: aligned.length,
    };
  }

  const assetCloses = aligned.map((row) => row.assetClose);
  const benchmarkCloses = aligned.map((row) => row.benchmarkClose);
  const relative = aligned.map((row) => row.assetClose / row.benchmarkClose);
  const relativeMomentum = pctChange(relative, 4);
  const ratioZ = rollingZScore(relative, 52);
  const momentumZ = rollingZScore(relativeMomentum, 26);
  const ema30 = indicators.ema(assetCloses, 30);

  const tail = [];
  for (let index = Math.max(0, aligned.length - 8); index < aligned.length; index += 1) {
    const ratioScore = scoreFromZ(ratioZ[index]);
    const momentumScore = scoreFromZ(momentumZ[index]);
    if (!Number.isFinite(ratioScore) || !Number.isFinite(momentumScore)) continue;
    tail.push({
      date: aligned[index].date,
      ratioScore,
      momentumScore,
      quadrant: quadrant(ratioScore, momentumScore),
    });
  }

  const ratioScore = scoreFromZ(latestFinite(ratioZ));
  const momentumScore = scoreFromZ(latestFinite(momentumZ));
  const currentQuadrant = quadrant(ratioScore, momentumScore);
  const excess4w = periodReturn(assetCloses, 4) - periodReturn(benchmarkCloses, 4);
  const excess12w = periodReturn(assetCloses, 12) - periodReturn(benchmarkCloses, 12);
  const excess26w = periodReturn(assetCloses, 26) - periodReturn(benchmarkCloses, 26);
  const latestPrice = assetCloses[assetCloses.length - 1];
  const latestEma30 = latestFinite(ema30);
  const absoluteTrendUp = Number.isFinite(latestEma30) && latestPrice > latestEma30 && periodReturn(assetCloses, 12) > 0;
  const volumeRatio = averageVolumeRatio(aligned);

  let action = 'NEUTRAL';
  if (currentQuadrant === 'LEADING' && absoluteTrendUp && excess12w > 0) action = 'OVERWEIGHT_CANDIDATE';
  else if (currentQuadrant === 'IMPROVING' && absoluteTrendUp && momentumScore >= 100) action = 'WATCH_FOR_ENTRY';
  else if (currentQuadrant === 'WEAKENING') action = 'HOLD_OR_TAKE_PROFIT';
  else if (currentQuadrant === 'LAGGING') action = 'UNDERWEIGHT_AVOID_NEW_BUY';
  else if ((currentQuadrant === 'LEADING' || currentQuadrant === 'IMPROVING') && !absoluteTrendUp) {
    action = 'RELATIVE_STRENGTH_ONLY_ABSOLUTE_TREND_WEAK';
  }

  const leaderboardScore = Number((
    (ratioScore - 100) * 0.35 +
    (momentumScore - 100) * 0.35 +
    clamp(excess4w * 100, -20, 20) * 0.10 +
    clamp(excess12w * 100, -30, 30) * 0.12 +
    clamp(excess26w * 100, -40, 40) * 0.08
  ).toFixed(3));

  const tailQuadrants = tail.map((row) => row.quadrant);
  const stability = tailQuadrants.length > 0
    ? tailQuadrants.filter((value) => value === currentQuadrant).length / tailQuadrants.length
    : 0;
  const confidence = aligned.length >= 100 && stability >= 0.5 ? 'HIGH' : aligned.length >= 70 ? 'MEDIUM' : 'LOW';

  return {
    ticker: sector.ticker,
    name: sector.name,
    available: true,
    asOf: aligned[aligned.length - 1].date,
    weeks: aligned.length,
    ratioScore,
    momentumScore,
    quadrant: currentQuadrant,
    tail,
    excessReturnPct: {
      w4: Number((excess4w * 100).toFixed(2)),
      w12: Number((excess12w * 100).toFixed(2)),
      w26: Number((excess26w * 100).toFixed(2)),
    },
    absoluteTrend: {
      up: absoluteTrendUp,
      latestPrice: Number(latestPrice.toFixed(2)),
      ema30Weekly: Number(latestEma30.toFixed(2)),
    },
    volumeRatio4v12: Number.isFinite(volumeRatio) ? Number(volumeRatio.toFixed(2)) : null,
    leaderboardScore,
    action,
    confidence,
    source: assetHistory.source,
  };
}

async function buildSectorRotation(options = {}) {
  const benchmarkHistory = await fetchDailyHistory(BENCHMARK.ticker, {
    market: 'US',
    range: options.range || '5y',
    timeoutMs: options.timeoutMs || 15000,
  });

  const results = await Promise.allSettled(US_SECTORS.map(async (sector) => {
    const history = await fetchDailyHistory(sector.ticker, {
      market: 'US',
      range: options.range || '5y',
      timeoutMs: options.timeoutMs || 15000,
    });
    return analyzeSector(history, benchmarkHistory, sector);
  }));

  const sectors = [];
  const errors = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') sectors.push(result.value);
    else errors.push({ ticker: US_SECTORS[index].ticker, error: result.reason?.message || String(result.reason) });
  });
  const available = sectors.filter((item) => item.available).sort((a, b) => b.leaderboardScore - a.leaderboardScore);

  return {
    schemaVersion: 1,
    rotationVersion: ROTATION_VERSION,
    methodology: 'TRANSPARENT_RRG_STYLE_NOT_OFFICIAL_JDK',
    benchmark: BENCHMARK,
    universe: US_SECTORS,
    generatedAt: new Date().toISOString(),
    asOf: available.map((item) => item.asOf).sort().slice(-1)[0] || null,
    sectors: available,
    unavailable: sectors.filter((item) => !item.available),
    errors,
    leaders: available.filter((item) => item.quadrant === 'LEADING').slice(0, 4),
    improving: available.filter((item) => item.quadrant === 'IMPROVING').slice(0, 4),
    weakening: available.filter((item) => item.quadrant === 'WEAKENING').slice(0, 4),
    lagging: available.filter((item) => item.quadrant === 'LAGGING').slice(0, 4),
    limitations: [
      'RELATIVE_PRICE_AND_MOMENTUM_NOT_NET_FUND_FLOW',
      'RESEARCH_DATA_ONLY_NOT_ORDER_EXECUTION_QUOTE',
      'SECTOR_SIGNAL_DOES_NOT_REPLACE_FUNDAMENTAL_VALUATION',
      'RRG_STYLE_CALCULATION_IS_NOT_THE_PROPRIETARY_JDK_FORMULA',
    ],
  };
}

function formatSectorRotation(snapshot) {
  const formatRows = (rows) => rows.length
    ? rows.map((item) => `${item.ticker} ${item.name}: ${item.action} | RS ${item.ratioScore.toFixed(1)} | Mom ${item.momentumScore.toFixed(1)} | 12W ${item.excessReturnPct.w12 >= 0 ? '+' : ''}${item.excessReturnPct.w12.toFixed(1)}%`).join('\n')
    : 'ไม่มี';

  return [
    '🧭 US SECTOR ROTATION — RRG-STYLE',
    `ข้อมูลถึง: ${snapshot.asOf || '-'}`,
    `Benchmark: ${snapshot.benchmark.ticker} (${snapshot.benchmark.name})`,
    '',
    '🟢 Leading',
    formatRows(snapshot.leaders),
    '',
    '🔵 Improving',
    formatRows(snapshot.improving),
    '',
    '🟡 Weakening',
    formatRows(snapshot.weakening),
    '',
    '🔴 Lagging',
    formatRows(snapshot.lagging),
    '',
    `Data errors: ${snapshot.errors.length}`,
    '⚠️ เป็น Relative Strength/Momentum ไม่ใช่ Fund Flow และไม่ใช่ Fair Value',
    '🔒 ใช้เป็น Sector Context ก่อนวิเคราะห์หุ้นรายตัว ไม่มีสิทธิ์สร้างออเดอร์เอง',
  ].join('\n');
}

module.exports = {
  ROTATION_VERSION,
  BENCHMARK,
  US_SECTORS,
  toWeekly,
  alignWeekly,
  pctChange,
  rollingZScore,
  quadrant,
  analyzeSector,
  buildSectorRotation,
  formatSectorRotation,
  _test: { mean, standardDeviation, scoreFromZ, periodReturn, averageVolumeRatio, isoWeekKey },
};