// Chart-only market-data adapter. Account reads and broker mutations are
// handled exclusively by the official SDK V2 gateway.
const https = require('https');

const REQUEST_TIMEOUT_MS = 9000;
const SYMBOL_RE = /^[A-Z0-9._-]{1,20}$/;
const ALLOWED_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);
const ALLOWED_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);

function headers() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'null',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

function response(statusCode, payload) {
  return { statusCode, headers: headers(), body: JSON.stringify(payload) };
}

function fetchChart(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'ThaiStockBot-Chart/1.0' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 500;
        if (status < 200 || status >= 300) {
          reject(new Error(`CHART_HTTP_${status}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('CHART_TIMEOUT'));
    });
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: headers(), body: '' };
  }
  const query = event.queryStringParameters || {};
  if (event.httpMethod !== 'GET' || String(query.action || '') !== 'chart') {
    return response(400, { error: 'Legacy engine is chart-only' });
  }
  const symbol = String(query.sym || '').toUpperCase().trim();
  if (!SYMBOL_RE.test(symbol)) return response(400, { error: 'Invalid or missing symbol' });
  const interval = String(query.interval || '1d');
  const range = String(query.range || '1y');
  if (!ALLOWED_INTERVALS.has(interval) || !ALLOWED_RANGES.has(range)) {
    return response(400, { error: 'Invalid chart interval or range' });
  }
  try {
    const yahooSymbol = symbol.includes('.') ? symbol : `${symbol}.BK`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}&includePrePost=false`;
    const result = JSON.parse(await fetchChart(url)).chart?.result?.[0];
    if (!result) throw new Error('CHART_DATA_MISSING');
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const candles = timestamps.map((time, index) => ({
      time,
      open: quote.open?.[index] == null ? null : Math.round(quote.open[index] * 100) / 100,
      high: quote.high?.[index] == null ? null : Math.round(quote.high[index] * 100) / 100,
      low: quote.low?.[index] == null ? null : Math.round(quote.low[index] * 100) / 100,
      close: quote.close?.[index] == null ? null : Math.round(quote.close[index] * 100) / 100,
      volume: Number(quote.volume?.[index] || 0),
    })).filter((candle) => candle.open != null && candle.close != null && candle.open > 0);
    return response(200, { sym: symbol, candles, count: candles.length });
  } catch (error) {
    return response(502, { sym: symbol, candles: [], error: 'Chart data unavailable' });
  }
};
