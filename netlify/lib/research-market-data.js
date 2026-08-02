const YAHOO_HOST = 'https://query1.finance.yahoo.com';
const SET_TRI_URL = 'https://www.set.or.th/en/market/index/tri/overview';

function normalizeSymbol(symbol) {
  const value = String(symbol || '').toUpperCase().trim();
  if (!/^[A-Z0-9.^_-]{1,30}$/.test(value)) throw new Error('INVALID_RESEARCH_SYMBOL');
  return value;
}

function yahooSymbol(symbol) {
  const value = normalizeSymbol(symbol);
  if (value.startsWith('^') || value.includes('.')) return value;
  return `${value}.BK`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Accept': 'application/json,text/html;q=0.9',
        'User-Agent': 'InnovestX-Research-Bot/1.0',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function parseYahooChart(payload, sourceSymbol) {
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error('YAHOO_NO_RESULT');
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];
  const candles = timestamps.map((time, index) => ({
    time: Number(time),
    date: new Date(Number(time) * 1000).toISOString().slice(0, 10),
    open: Number(quote.open?.[index]),
    high: Number(quote.high?.[index]),
    low: Number(quote.low?.[index]),
    close: Number(quote.close?.[index]),
    adjustedClose: Number(adjclose[index] ?? quote.close?.[index]),
    volume: Number(quote.volume?.[index] || 0),
  })).filter((item) =>
    Number.isFinite(item.open) && item.open > 0 &&
    Number.isFinite(item.high) && item.high > 0 &&
    Number.isFinite(item.low) && item.low > 0 &&
    Number.isFinite(item.close) && item.close > 0
  );

  const dividends = Object.values(result.events?.dividends || {}).map((item) => ({
    type: 'DIVIDEND',
    date: new Date(Number(item.date) * 1000).toISOString().slice(0, 10),
    amount: Number(item.amount || 0),
  }));
  const splits = Object.values(result.events?.splits || {}).map((item) => ({
    type: 'SPLIT',
    date: new Date(Number(item.date) * 1000).toISOString().slice(0, 10),
    numerator: Number(item.numerator || 0),
    denominator: Number(item.denominator || 0),
    splitRatio: String(item.splitRatio || ''),
  }));

  return {
    symbol: sourceSymbol,
    source: 'YAHOO_FINANCE_RESEARCH_ONLY',
    fetchedAt: new Date().toISOString(),
    currency: result.meta?.currency || 'THB',
    exchangeTimezone: result.meta?.exchangeTimezoneName || null,
    candles,
    events: [...dividends, ...splits].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

async function fetchDailyHistory(symbol, options = {}) {
  const normalized = normalizeSymbol(symbol);
  const querySymbol = yahooSymbol(normalized);
  const range = options.range || '3y';
  const interval = options.interval || '1d';
  const url = `${YAHOO_HOST}/v8/finance/chart/${encodeURIComponent(querySymbol)}` +
    `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}` +
    '&includePrePost=false&events=div%2Csplits';
  const text = await fetchWithTimeout(url, {}, options.timeoutMs || 12000);
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error('YAHOO_INVALID_JSON'); }
  return parseYahooChart(payload, normalized);
}

function parseSetTriHtml(html) {
  const cleaned = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const patterns = [
    /SET TRI\s+([0-9,]+(?:\.[0-9]+)?)/i,
    /SET TRI[^0-9]{0,80}([0-9,]+(?:\.[0-9]+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(cleaned);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0) return value;
  }
  throw new Error('SET_TRI_PARSE_FAILED');
}

async function fetchSetTriSnapshot(options = {}) {
  const html = await fetchWithTimeout(SET_TRI_URL, {
    headers: { 'Accept': 'text/html' },
  }, options.timeoutMs || 12000);
  return {
    symbol: 'SET_TRI',
    value: parseSetTriHtml(html),
    source: 'SET_OFFICIAL_TRI_OVERVIEW',
    sourceUrl: SET_TRI_URL,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  fetchDailyHistory,
  fetchSetTriSnapshot,
  parseYahooChart,
  parseSetTriHtml,
  _test: { normalizeSymbol, yahooSymbol },
};
