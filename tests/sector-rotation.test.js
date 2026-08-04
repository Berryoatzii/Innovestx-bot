const test = require('node:test');
const assert = require('node:assert/strict');

const { _test: marketDataTest } = require('../netlify/lib/research-market-data');
const {
  US_SECTORS,
  toWeekly,
  alignWeekly,
  rollingZScore,
  quadrant,
  analyzeSector,
  formatSectorRotation,
} = require('../netlify/lib/sector-rotation');

function makeDailyHistory({ start = '2023-01-02', days = 900, dailyGrowth = 0.0005, volume = 1000000 }) {
  const rows = [];
  const startDate = new Date(`${start}T00:00:00.000Z`);
  let price = 100;
  for (let index = 0; index < days; index += 1) {
    const date = new Date(startDate.getTime() + index * 86400000);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    price *= 1 + dailyGrowth + Math.sin(index / 17) * 0.0002;
    rows.push({
      time: Math.floor(date.getTime() / 1000),
      date: date.toISOString().slice(0, 10),
      open: price * 0.998,
      high: price * 1.004,
      low: price * 0.996,
      close: price,
      adjustedClose: price,
      volume: volume + index * 100,
    });
  }
  return { source: 'TEST_DATA', candles: rows, events: [] };
}

test('research market data keeps US symbols unchanged and Thai symbols suffixed', () => {
  assert.equal(marketDataTest.yahooSymbol('SPY', 'US'), 'SPY');
  assert.equal(marketDataTest.yahooSymbol('XLK', 'GLOBAL'), 'XLK');
  assert.equal(marketDataTest.yahooSymbol('AIT', 'TH'), 'AIT.BK');
  assert.equal(marketDataTest.yahooSymbol('^SET.BK', 'TH'), '^SET.BK');
});

test('US sector universe contains the 11 Select Sector ETF proxies', () => {
  assert.equal(US_SECTORS.length, 11);
  assert.deepEqual(
    US_SECTORS.map((item) => item.ticker).sort(),
    ['XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU', 'XLV', 'XLY'].sort()
  );
});

test('daily candles are reduced to aligned weekly observations', () => {
  const asset = toWeekly(makeDailyHistory({ days: 120 }).candles);
  const benchmark = toWeekly(makeDailyHistory({ days: 120, dailyGrowth: 0.0002 }).candles);
  const aligned = alignWeekly(asset, benchmark);
  assert.ok(asset.length >= 15);
  assert.equal(aligned.length, Math.min(asset.length, benchmark.length));
  assert.ok(aligned.every((row) => row.assetClose > 0 && row.benchmarkClose > 0));
});

test('quadrants match ratio and momentum positions around 100', () => {
  assert.equal(quadrant(101, 102), 'LEADING');
  assert.equal(quadrant(101, 98), 'WEAKENING');
  assert.equal(quadrant(98, 98), 'LAGGING');
  assert.equal(quadrant(98, 102), 'IMPROVING');
});

test('rolling z-score waits for enough observations and normalizes series', () => {
  const values = Array.from({ length: 60 }, (_, index) => index + 1);
  const result = rollingZScore(values, 52);
  assert.equal(result[50], null);
  assert.ok(Number.isFinite(result[59]));
  assert.ok(result[59] > 0);
});

test('sector analysis adds absolute-trend confirmation beyond relative strength', () => {
  const benchmark = makeDailyHistory({ dailyGrowth: 0.0002 });
  const strongSector = makeDailyHistory({ dailyGrowth: 0.0008 });
  const result = analyzeSector(strongSector, benchmark, { ticker: 'XLK', name: 'Technology' });

  assert.equal(result.available, true);
  assert.ok(['LEADING', 'WEAKENING', 'IMPROVING', 'LAGGING'].includes(result.quadrant));
  assert.ok(Number.isFinite(result.ratioScore));
  assert.ok(Number.isFinite(result.momentumScore));
  assert.ok(Number.isFinite(result.leaderboardScore));
  assert.equal(typeof result.absoluteTrend.up, 'boolean');
  assert.notEqual(result.action, undefined);
});

test('formatted rotation report states that the signal is not fund flow or fair value', () => {
  const snapshot = {
    asOf: '2026-08-03',
    benchmark: { ticker: 'SPY', name: 'S&P 500 ETF' },
    leaders: [], improving: [], weakening: [], lagging: [], errors: [],
  };
  const text = formatSectorRotation(snapshot);
  assert.match(text, /ไม่ใช่ Fund Flow/);
  assert.match(text, /ไม่ใช่ Fair Value/);
  assert.match(text, /ไม่มีสิทธิ์สร้างออเดอร์เอง/);
});