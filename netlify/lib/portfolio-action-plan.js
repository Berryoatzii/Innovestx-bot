const { handler: invxHandler } = require('../functions/invx');
const { fetchDailyHistory } = require('./research-market-data');
const { indicators } = require('./deterministic-strategy');
const { getSnapshot } = require('./fundamental-snapshot-store');
const { getClassification, suggestBucket } = require('./portfolio-classification-store');

const PLAN_VERSION = 'PORTFOLIO_ACTION_PLAN_V1.0.0';

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function tickSize(price, instrumentType = 'STOCK') {
  if (instrumentType === 'ETF' || instrumentType === 'FUND') return 0.01;
  const value = Number(price || 0);
  if (value < 2) return 0.01;
  if (value < 5) return 0.02;
  if (value < 10) return 0.05;
  if (value < 25) return 0.10;
  if (value < 100) return 0.25;
  if (value < 200) return 0.50;
  if (value < 400) return 1.00;
  return 2.00;
}

function roundToTick(price, direction = 'nearest') {
  const value = Number(price || 0);
  if (!(value > 0)) return null;
  const tick = tickSize(value);
  const units = value / tick;
  const rounded = direction === 'up'
    ? Math.ceil(units - 1e-9)
    : direction === 'down'
      ? Math.floor(units + 1e-9)
      : Math.round(units);
  return Number((rounded * tick).toFixed(2));
}

function macd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = indicators.ema(values, fastPeriod);
  const slow = indicators.ema(values, slowPeriod);
  const line = values.map((_, index) => {
    if (!Number.isFinite(fast[index]) || !Number.isFinite(slow[index])) return null;
    return fast[index] - slow[index];
  });
  const compact = line.filter(Number.isFinite);
  const compactSignal = indicators.ema(compact, signalPeriod);
  const signal = new Array(values.length).fill(null);
  let compactIndex = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (!Number.isFinite(line[index])) continue;
    signal[index] = compactSignal[compactIndex] ?? null;
    compactIndex += 1;
  }
  const histogram = line.map((value, index) => (
    Number.isFinite(value) && Number.isFinite(signal[index]) ? value - signal[index] : null
  ));
  return { line, signal, histogram };
}

function bollinger(values, period = 20, multiplier = 2) {
  const middle = new Array(values.length).fill(null);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const window = values.slice(index - period + 1, index + 1);
    const average = mean(window);
    const sd = standardDeviation(window);
    middle[index] = average;
    upper[index] = average + multiplier * sd;
    lower[index] = average - multiplier * sd;
  }
  return { middle, upper, lower };
}

function uniqueLevels(levels, currentPrice) {
  const normalized = levels
    .map((item) => ({ ...item, price: roundToTick(item.price) }))
    .filter((item) => Number.isFinite(item.price) && item.price > 0)
    .sort((a, b) => a.price - b.price);
  const rows = [];
  for (const item of normalized) {
    if (rows.some((row) => Math.abs(row.price - item.price) < tickSize(currentPrice) * 0.75)) continue;
    rows.push(item);
  }
  return rows;
}

function analyzeTechnical(candles, quote = {}) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return { available: false, reason: 'INSUFFICIENT_CHART_BARS' };
  }
  const closes = candles.map((item) => finite(item.adjustedClose || item.close, 0));
  const highs = candles.map((item) => finite(item.high, 0));
  const lows = candles.map((item) => finite(item.low, 0));
  const ema20 = indicators.ema(closes, 20);
  const ema50 = indicators.ema(closes, 50);
  const rsi14 = indicators.rsi(closes, 14);
  const atr14 = indicators.atr(candles, 14);
  const macdData = macd(closes);
  const bands = bollinger(closes, 20, 2);
  const index = closes.length - 1;
  const chartClose = closes[index];
  const liveLast = finite(quote.last, chartClose);
  const current = liveLast > 0 ? liveLast : chartClose;
  const high20 = Math.max(...highs.slice(-20));
  const low20 = Math.min(...lows.slice(-20));
  const high60 = Math.max(...highs.slice(-60));
  const low60 = Math.min(...lows.slice(-60));
  const range60 = Math.max(0, high60 - low60);
  const fib382 = low60 + range60 * 0.382;
  const fib500 = low60 + range60 * 0.500;
  const fib618 = low60 + range60 * 0.618;

  const candidateLevels = [
    { name: 'EMA20', price: ema20[index] },
    { name: 'EMA50', price: ema50[index] },
    { name: 'BB_UPPER', price: bands.upper[index] },
    { name: 'BB_MIDDLE', price: bands.middle[index] },
    { name: 'BB_LOWER', price: bands.lower[index] },
    { name: 'HIGH_20D', price: high20 },
    { name: 'LOW_20D', price: low20 },
    { name: 'FIB_38.2', price: fib382 },
    { name: 'FIB_50.0', price: fib500 },
    { name: 'FIB_61.8', price: fib618 },
  ];
  const levels = uniqueLevels(candidateLevels, current);
  const supports = levels.filter((item) => item.price < current).sort((a, b) => b.price - a.price);
  const resistances = levels.filter((item) => item.price > current).sort((a, b) => a.price - b.price);
  const currentRsi = finite(rsi14[index]);
  const currentAtr = finite(atr14[index]);
  const currentMacd = finite(macdData.line[index]);
  const currentSignal = finite(macdData.signal[index]);
  const currentHistogram = finite(macdData.histogram[index]);
  const currentEma20 = finite(ema20[index]);
  const currentEma50 = finite(ema50[index]);
  const lowerBand = finite(bands.lower[index]);
  const upperBand = finite(bands.upper[index]);
  const oversold = (currentRsi != null && currentRsi < 35) || (lowerBand != null && current < lowerBand);
  const trendBroken = currentEma20 != null && currentEma50 != null && current < currentEma20 && currentEma20 < currentEma50;
  const momentumWeak = currentHistogram != null && currentHistogram < 0;
  const nearResistance = resistances[0] && Math.abs(resistances[0].price - current) / current <= 0.025;

  let timing = 'HOLD_AND_REVIEW';
  if (oversold) timing = 'WAIT_FOR_REBOUND';
  else if (trendBroken && momentumWeak) timing = 'REDUCE_ON_REBOUND';
  else if (nearResistance && momentumWeak) timing = 'REDUCE_AT_RESISTANCE';

  const resistance1 = resistances[0]?.price || (currentAtr ? roundToTick(current + currentAtr) : null);
  const resistance2 = resistances[1]?.price || (currentAtr ? roundToTick(current + currentAtr * 2) : null);
  const support1 = supports[0]?.price || (currentAtr ? roundToTick(current - currentAtr) : null);
  const support2 = supports[1]?.price || (currentAtr ? roundToTick(current - currentAtr * 2) : null);

  let sellZoneLow = null;
  let sellZoneHigh = null;
  if (timing === 'WAIT_FOR_REBOUND' || timing === 'REDUCE_ON_REBOUND' || timing === 'REDUCE_AT_RESISTANCE') {
    sellZoneLow = resistance1;
    sellZoneHigh = resistance2 || resistance1;
  }

  return {
    available: true,
    date: candles[index].date,
    current: roundToTick(current),
    ema20: roundToTick(currentEma20),
    ema50: roundToTick(currentEma50),
    rsi14: currentRsi == null ? null : Number(currentRsi.toFixed(1)),
    macd: currentMacd == null ? null : Number(currentMacd.toFixed(4)),
    macdSignal: currentSignal == null ? null : Number(currentSignal.toFixed(4)),
    macdHistogram: currentHistogram == null ? null : Number(currentHistogram.toFixed(4)),
    atr14: currentAtr == null ? null : Number(currentAtr.toFixed(3)),
    bollingerUpper: roundToTick(upperBand),
    bollingerLower: roundToTick(lowerBand),
    support1,
    support2,
    resistance1,
    resistance2,
    timing,
    oversold,
    trendBroken,
    momentumWeak,
    sellZoneLow,
    sellZoneHigh,
  };
}

function thesisBreak(snapshot) {
  if (!snapshot) return { broken: false, reasons: [] };
  const reasons = [];
  if (snapshot.moatLost) reasons.push('MOAT_LOST');
  if (snapshot.materialDisruption) reasons.push('MATERIAL_DISRUPTION');
  if (snapshot.governanceRedFlag) reasons.push('GOVERNANCE_RED_FLAG');
  if (snapshot.auditorOpinionChanged) reasons.push('AUDITOR_OPINION_CHANGED');
  if (Number(snapshot.dividendChangePct || 0) <= -30) reasons.push('DIVIDEND_CUT_30PCT');
  if (Number(snapshot.consecutiveWeakQuarters || 0) >= 2) reasons.push('TWO_WEAK_QUARTERS');
  return { broken: reasons.length > 0, reasons };
}

function valuationBand(snapshot, currentPrice) {
  if (!snapshot || !snapshot.verifiedAt || Number(snapshot.completeness?.ratio || 0) < 1) {
    return { available: false, reason: 'VERIFIED_FUNDAMENTAL_SNAPSHOT_REQUIRED' };
  }
  let low = finite(snapshot.market?.fairValueLow);
  let high = finite(snapshot.market?.fairValueHigh);
  let base = low && high ? (low + high) / 2 : null;
  let method = low && high ? 'VERIFIED_FAIR_VALUE_RANGE' : null;

  if (!(low > 0 && high > 0)) {
    const latestAnnual = [...(snapshot.annuals || [])].reverse().find((item) => Number(item.eps || 0) > 0);
    const anchors = [snapshot.market?.ownMedianPe, snapshot.market?.sectorMedianPe]
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (latestAnnual && anchors.length > 0) {
      const anchorPe = anchors.reduce((sum, value) => sum + value, 0) / anchors.length;
      base = Number(latestAnnual.eps) * anchorPe;
      low = base * 0.85;
      high = base * 1.15;
      method = 'EPS_X_VERIFIED_MEDIAN_PE';
    }
  }

  if (!(low > 0 && high > 0)) {
    return { available: false, reason: 'FAIR_VALUE_INPUTS_INCOMPLETE' };
  }
  low = roundToTick(low);
  base = roundToTick(base || (low + high) / 2);
  high = roundToTick(high);
  const current = Number(currentPrice || 0);
  const status = current > 0
    ? current < low ? 'BELOW_VALUE_RANGE' : current > high ? 'ABOVE_VALUE_RANGE' : 'WITHIN_VALUE_RANGE'
    : 'CURRENT_PRICE_UNAVAILABLE';
  return { available: true, low, base, high, status, method, asOf: snapshot.asOf };
}

function safeTrancheQuantity(heldQuantity, fraction = 0.25, boardLot = 100) {
  const held = Math.floor(Number(heldQuantity || 0));
  const lot = Math.max(1, Math.floor(Number(boardLot || 100)));
  if (held < lot * 2) return 0;
  const quantity = Math.floor((held * fraction) / lot) * lot;
  if (quantity < lot || quantity >= held) return 0;
  return quantity;
}

function quantityPlan({ bucket, quantity, technical, fundamentalBreak, boardLot = 100 }) {
  if (bucket === 'REVIEW') {
    return { first: 0, second: 0, reason: 'REVIEW_BUCKET_REQUIRES_CLASSIFICATION' };
  }
  if (bucket === 'CORE' && !fundamentalBreak.broken) {
    return { first: 0, second: 0, reason: 'CORE_TECHNICAL_SIGNAL_CANNOT_AUTHORIZE_SELL' };
  }
  if (!technical?.available || technical.timing === 'HOLD_AND_REVIEW') {
    return { first: 0, second: 0, reason: 'NO_CONFIRMED_SELL_TIMING' };
  }
  const fraction = bucket === 'ACTIVE' && technical.trendBroken ? 0.25 : 0.20;
  const first = safeTrancheQuantity(quantity, fraction, boardLot);
  const remaining = Math.max(0, Number(quantity || 0) - first);
  const second = first > 0 ? Math.min(first, safeTrancheQuantity(remaining, fraction, boardLot)) : 0;
  return {
    first,
    second,
    reason: first > 0 ? 'PARTIAL_EXIT_ONLY' : 'POSITION_TOO_SMALL_FOR_SAFE_PARTIAL_EXIT',
  };
}

async function fetchLiveQuote(symbol, event) {
  const response = await invxHandler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { action: 'quote', sym: symbol },
    body: '',
    requestContext: event?.requestContext,
  });
  let payload = {};
  try { payload = JSON.parse(response.body || '{}'); }
  catch { payload = {}; }
  if (response.statusCode !== 200 || !(Number(payload.last || 0) > 0)) {
    return { available: false, error: payload.error || `QUOTE_HTTP_${response.statusCode}` };
  }
  return {
    available: true,
    symbol,
    last: finite(payload.last, 0),
    bid: finite(payload.bid, 0),
    ask: finite(payload.ask, 0),
    high: finite(payload.high, 0),
    low: finite(payload.low, 0),
    prior: finite(payload.prior, 0),
    pct: finite(payload.pct, 0),
    volume: finite(payload.volume, 0),
  };
}

function cleanReason(reason) {
  const text = String(reason || '').replace(/\uFFFD+/g, '').replace(/\s+/g, ' ').trim();
  return text.length >= 12 ? text.slice(0, 500) : 'คำอธิบายจาก AI ไม่สมบูรณ์ จึงใช้กฎและข้อมูลตลาดเป็นหลัก';
}

async function buildActionPlan(observation, event = {}) {
  const symbol = String(observation.symbol || observation.sym || '').toUpperCase();
  const quotePromise = fetchLiveQuote(symbol, event).catch((error) => ({ available: false, error: error.message }));
  const historyPromise = fetchDailyHistory(symbol, { range: '3y' }).catch((error) => ({ candles: [], error: error.message }));
  const snapshotPromise = getSnapshot(symbol, event).catch(() => null);
  const classificationPromise = getClassification(symbol, event).catch(() => null);
  const [quote, history, snapshot, classification] = await Promise.all([
    quotePromise,
    historyPromise,
    snapshotPromise,
    classificationPromise,
  ]);

  const suggestion = suggestBucket(symbol);
  const bucket = classification?.bucket || 'REVIEW';
  const currentMarket = quote.available ? quote.last : finite(observation.referencePrice || observation.mkt, 0);
  const technical = analyzeTechnical(history.candles || [], quote.available ? quote : { last: currentMarket });
  const fundamentals = valuationBand(snapshot, currentMarket);
  const fundamentalBreak = thesisBreak(snapshot);
  const quantity = Math.floor(Number(observation.qty || observation.quantityObserved || 0));
  const averageCost = finite(observation.avg, null);
  const pnlPct = averageCost > 0 && currentMarket > 0
    ? (currentMarket - averageCost) / averageCost * 100
    : finite(observation.pnlPct, null);
  const quantities = quantityPlan({
    bucket,
    quantity,
    technical,
    fundamentalBreak,
    boardLot: Number(process.env.PROPOSAL_BOARD_LOT || 100),
  });

  return {
    planVersion: PLAN_VERSION,
    symbol,
    bucket,
    classificationExplicit: Boolean(classification?.explicit),
    suggestedBucket: suggestion.bucket,
    market: {
      current: roundToTick(currentMarket),
      bid: quote.available ? roundToTick(quote.bid) : null,
      ask: quote.available ? roundToTick(quote.ask) : null,
      high: quote.available ? roundToTick(quote.high) : null,
      low: quote.available ? roundToTick(quote.low) : null,
      pct: quote.available ? quote.pct : null,
      source: quote.available ? 'SETTRADE_LIVE_QUOTE' : 'PORTFOLIO_PRICE_FALLBACK',
    },
    position: {
      quantity,
      averageCost,
      pnlPct: pnlPct == null ? null : Number(pnlPct.toFixed(2)),
    },
    valuation: fundamentals,
    technical,
    fundamentalBreak,
    quantities,
    aiObservation: {
      side: String(observation.side || '').toUpperCase(),
      grade: observation.grade || null,
      finalScore: observation.finalScore ?? observation.final_score ?? null,
      reason: cleanReason(observation.reason),
      authority: 'ADVISORY_ONLY',
    },
    decisionAuthority: 'DETERMINISTIC_MARKET_AND_RISK_PLAN',
    liveOrderCreated: false,
  };
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('th-TH', { maximumFractionDigits: digits }) : '-';
}

function formatActionPlan(plan) {
  const timingMap = {
    WAIT_FOR_REBOUND: 'รอเด้ง ไม่ขายไล่ราคาต่ำ',
    REDUCE_ON_REBOUND: 'แบ่งขายเมื่อเด้งเข้าแนวต้าน',
    REDUCE_AT_RESISTANCE: 'แบ่งขายบริเวณแนวต้าน',
    HOLD_AND_REVIEW: 'ยังไม่พบจังหวะขายที่ยืนยันด้วยกราฟ',
  };
  const rows = [
    `📌 DECISION PLAN — ${plan.symbol}`,
    `หมวด: ${plan.bucket}${plan.classificationExplicit ? '' : ` (ยังไม่ยืนยัน; รายการเดิมแนะนำ ${plan.suggestedBucket})`}`,
    `ตลาดล่าสุด: ${formatNumber(plan.market.current)} | Bid ${formatNumber(plan.market.bid)} | Ask ${formatNumber(plan.market.ask)}`,
    `ถือ: ${formatNumber(plan.position.quantity, 0)} หุ้น | ทุน ${formatNumber(plan.position.averageCost)} | P/L ${formatNumber(plan.position.pnlPct)}%`,
  ];

  if (plan.valuation.available) {
    rows.push(
      `มูลค่าธุรกิจ: ${formatNumber(plan.valuation.low)}–${formatNumber(plan.valuation.high)} บาท (กลาง ${formatNumber(plan.valuation.base)})`,
      `สถานะราคา: ${plan.valuation.status} | ข้อมูลงบ ณ ${plan.valuation.asOf}`
    );
  } else {
    rows.push(`มูลค่าธุรกิจ: ยังประเมินไม่ได้ — ${plan.valuation.reason}`);
  }

  if (plan.technical.available) {
    rows.push(
      `กราฟ: EMA20 ${formatNumber(plan.technical.ema20)} | EMA50 ${formatNumber(plan.technical.ema50)} | RSI ${formatNumber(plan.technical.rsi14, 1)}`,
      `MACD Hist ${formatNumber(plan.technical.macdHistogram, 4)} | ATR ${formatNumber(plan.technical.atr14, 3)}`,
      `แนวรับ: ${formatNumber(plan.technical.support1)} / ${formatNumber(plan.technical.support2)}`,
      `แนวต้าน: ${formatNumber(plan.technical.resistance1)} / ${formatNumber(plan.technical.resistance2)}`,
      `จังหวะ: ${timingMap[plan.technical.timing] || plan.technical.timing}`
    );
  } else {
    rows.push(`กราฟ: ยังวิเคราะห์ไม่ได้ — ${plan.technical.reason}`);
  }

  if (plan.quantities.first > 0) {
    rows.push(
      `ไม้ 1: ${formatNumber(plan.quantities.first, 0)} หุ้น ช่วง ${formatNumber(plan.technical.sellZoneLow)}–${formatNumber(plan.technical.sellZoneHigh)} บาท`,
      plan.quantities.second > 0
        ? `ไม้ 2: ${formatNumber(plan.quantities.second, 0)} หุ้น เมื่อถึงแนวต้านถัดไปและ Momentum ยังไม่ฟื้น`
        : 'ไม้ 2: ไม่มี — รอประเมินใหม่หลังไม้แรก'
    );
  } else {
    rows.push(`จำนวนที่ระบบอนุญาตเสนอขายตอนนี้: 0 หุ้น — ${plan.quantities.reason}`);
  }

  if (plan.fundamentalBreak.broken) {
    rows.push(`Fundamental warning: ${plan.fundamentalBreak.reasons.join(', ')}`);
  }
  rows.push(
    `AI observation: ${plan.aiObservation.reason}`,
    '🔒 แผนนี้ยังไม่ใช่ออเดอร์ และไม่ส่งคำสั่งซื้อขายอัตโนมัติ'
  );
  return rows.join('\n');
}

module.exports = {
  PLAN_VERSION,
  tickSize,
  roundToTick,
  macd,
  bollinger,
  analyzeTechnical,
  valuationBand,
  thesisBreak,
  safeTrancheQuantity,
  quantityPlan,
  buildActionPlan,
  formatActionPlan,
  _test: { mean, standardDeviation, cleanReason, uniqueLevels },
};