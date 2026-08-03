const BASE = 'https://www.set.or.th/en/market/product/stock/quote';

function normalizeSymbol(symbol) {
  const value = String(symbol || '').toUpperCase().trim();
  if (!/^[A-Z0-9._-]{1,20}$/.test(value)) throw new Error('INVALID_SET_SYMBOL');
  return value;
}

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'InnovestX-Fundamental-Research/1.0',
        'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
      },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`SET_HTTP_${response.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"');
}

function htmlToText(html) {
  return decodeEntities(String(html || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberFrom(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(String(match[1]).replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function textFrom(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return String(match[1]).trim();
  }
  return null;
}

function parseFactsheetHtml(html, symbol) {
  const text = htmlToText(html);
  const normalized = normalizeSymbol(symbol);
  const asOf = textFrom(text, [
    /As of\s+(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/i,
    /ข้อมูลล่าสุด\s*(\d{1,2}\s+\S+\s+\d{4})/i,
  ]);
  const businessType = textFrom(text, [
    /Business Type\s+([\s\S]{1,1200}?)(?:Paid-up|ทุนชำระแล้ว)/i,
    /ประเภทธุรกิจ\s+([\s\S]{1,1200}?)(?:ทุนชำระแล้ว|Paid-up)/i,
  ]);
  const auditOpinion = textFrom(text, [
    /Latest Type of Report\s+(.{1,120}?)(?:F\/S Year Ended|Financial Statements|Remark)/i,
    /ประเภทความเห็นล่าสุด\s+(.{1,120}?)(?:รอบบัญชี|ข้อมูลการส่งงบ)/i,
  ]);
  const price = numberFrom(text, [/Price \(Baht\)\s+([0-9,.]+)/i, /ราคา \(บาท\)\s+([0-9,.]+)/i]);
  const pe = numberFrom(text, [/P\/E \(X\)\s+([0-9,.]+)/i, /P\/E\s+([0-9,.]+)/i]);
  const pbv = numberFrom(text, [/P\/BV \(X\)\s+([0-9,.]+)/i, /P\/BV\s+([0-9,.]+)/i]);
  const evEbitda = numberFrom(text, [/EV\/EBITDA\s+([0-9,.]+)/i]);
  const marketCap = numberFrom(text, [/Market Cap \(M\.Baht\)\s+([0-9,.]+)/i, /มูลค่าหลักทรัพย์ตามราคาตลาด.*?([0-9,.]+)/i]);

  return {
    symbol: normalized,
    source: 'SET_OFFICIAL_FACTSHEET',
    sourceUrl: `${BASE}/${normalized.toLowerCase()}/factsheet`,
    fetchedAt: new Date().toISOString(),
    asOfText: asOf,
    businessType,
    auditOpinion,
    market: { price, pe, pbv, evEbitda, marketCapMbaht: marketCap },
    parserCompleteness: {
      price: price != null,
      pe: pe != null,
      pbv: pbv != null,
      businessType: Boolean(businessType),
      auditOpinion: Boolean(auditOpinion),
    },
  };
}

function extractNumericSeriesAfterLabel(text, labels, maxValues = 8) {
  for (const label of labels) {
    const index = text.toLowerCase().indexOf(label.toLowerCase());
    if (index < 0) continue;
    const section = text.slice(index + label.length, index + label.length + 800);
    const matches = [...section.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)]
      .map((match) => Number(match[0].replace(/,/g, '')))
      .filter(Number.isFinite)
      .slice(0, maxValues);
    if (matches.length > 0) return matches;
  }
  return [];
}

function parseHighlightsHtml(html, symbol) {
  const text = htmlToText(html);
  const normalized = normalizeSymbol(symbol);
  const series = {
    roePct: extractNumericSeriesAfterLabel(text, ['Return on Equity (%)', 'อัตราผลตอบแทนผู้ถือหุ้น (%)']),
    roaPct: extractNumericSeriesAfterLabel(text, ['Return on Asset (%)', 'อัตราผลตอบแทนจากสินทรัพย์ (%)']),
    debtToEquity: extractNumericSeriesAfterLabel(text, ['Debt to Equity (X)', 'อัตราส่วนหนี้สินต่อส่วนของผู้ถือหุ้น (เท่า)']),
    netProfit: extractNumericSeriesAfterLabel(text, ['Net Profit', 'กำไรสุทธิ']),
    eps: extractNumericSeriesAfterLabel(text, ['Earnings Per Share', 'กำไรต่อหุ้น']),
    operatingCashFlow: extractNumericSeriesAfterLabel(text, ['Cash Flow from Operating Activities', 'กระแสเงินสดจากกิจกรรมดำเนินงาน']),
    retainedEarnings: extractNumericSeriesAfterLabel(text, ['Retained Earnings', 'กำไรสะสม']),
  };
  return {
    symbol: normalized,
    source: 'SET_OFFICIAL_COMPANY_HIGHLIGHTS',
    sourceUrl: `${BASE}/${normalized.toLowerCase()}/financial-statement/company-highlights`,
    fetchedAt: new Date().toISOString(),
    series,
    parserCompleteness: Object.fromEntries(Object.entries(series).map(([key, values]) => [key, values.length > 0])),
  };
}

async function fetchOfficialSetFundamentalPages(symbol, options = {}) {
  const normalized = normalizeSymbol(symbol);
  const factsheetUrl = `${BASE}/${normalized.toLowerCase()}/factsheet`;
  const highlightsUrl = `${BASE}/${normalized.toLowerCase()}/financial-statement/company-highlights`;
  const [factsheetResult, highlightsResult] = await Promise.allSettled([
    fetchText(factsheetUrl, options.timeoutMs),
    fetchText(highlightsUrl, options.timeoutMs),
  ]);

  return {
    symbol: normalized,
    fetchedAt: new Date().toISOString(),
    factsheet: factsheetResult.status === 'fulfilled'
      ? parseFactsheetHtml(factsheetResult.value, normalized)
      : { error: factsheetResult.reason?.message || 'FACTSHEET_FETCH_FAILED' },
    highlights: highlightsResult.status === 'fulfilled'
      ? parseHighlightsHtml(highlightsResult.value, normalized)
      : { error: highlightsResult.reason?.message || 'HIGHLIGHTS_FETCH_FAILED' },
  };
}

module.exports = {
  fetchOfficialSetFundamentalPages,
  parseFactsheetHtml,
  parseHighlightsHtml,
  htmlToText,
  _test: { normalizeSymbol, numberFrom, textFrom, extractNumericSeriesAfterLabel },
};
