// Netlify Function: /api/invx
// Proxy ระหว่าง Browser กับ InnovestX API (แก้ CORS)
// Deploy ที่ Netlify → เรียก /.netlify/functions/invx

const https = require('https');
const crypto = require('crypto');

// ── Settrade ECDSA-SHA256 Signer ──────────────────────────────────────────────
// sdk source: settrade_v2/util.py → create_sha256_with_ecdsa_signature
// api_secret = base64-encoded raw 32-byte secp256r1 private key
const PKCS8_SECP256R1_PREFIX = Buffer.from(
  '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'
);
function signSettrade(appId, appSecret, params = '') {
  const timestamp = Date.now().toString();
  const content = `${appId}.${params}.${timestamp}`;
  const rawKey = Buffer.from(appSecret, 'base64');
  const pkcs8Der = Buffer.concat([PKCS8_SECP256R1_PREFIX, rawKey]);
  const privKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  const sig = crypto.createSign('SHA256');
  sig.update(content, 'utf8');
  return { signature: sig.sign(privKey, 'hex'), timestamp };
}

async function settradeLogin(appId, appSecret, brokerId, appCode) {
  const { signature, timestamp } = signSettrade(appId, appSecret);
  const loginUrl = `https://open-api.settrade.com/api/oam/v1/${brokerId}/broker-apps/${appCode}/login`;
  const r = await httpsPost(loginUrl, {
    apiKey: appId, params: '', signature, timestamp,
  });
  if (!r.access_token) throw new Error(`Settrade login failed: ${JSON.stringify(r).slice(0, 200)}`);
  return { token: r.access_token, tokenType: r.token_type || 'Bearer' };
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject); req.write(postData); req.end();
  });
}

function authGet(url, token, tokenType = 'Bearer') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'GET',
      headers: { 'Authorization': `${tokenType} ${token}`, 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject); req.end();
  });
}

function authPost(url, token, tokenType, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'POST',
      headers: {
        'Authorization': `${tokenType} ${token}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Accept': 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        const sc = res.statusCode; const loc = res.headers?.location || '';
        try { resolve({ statusCode: sc, location: loc, body: JSON.parse(data) }); }
        catch(e) { resolve({ statusCode: sc, location: loc, body: data }); }
      });
    });
    req.on('error', reject); req.write(postData); req.end();
  });
}

function authPatch(url, token, tokenType, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'PATCH',
      headers: {
        'Authorization': `${tokenType} ${token}`,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Accept': 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject); req.write(postData); req.end();
  });
}

exports.handler = async (event, context) => {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, api-key, api-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  // Parse request
  const body = event.body ? JSON.parse(event.body) : {};
  // ใช้ Environment Variables เป็น default (ไม่ต้องส่ง Key จาก Browser)
  const apiKey    = event.headers['api-key']    || body.api_key    || process.env.INVX_KEY    || '';
  const apiSecret = event.headers['api-secret'] || body.api_secret || process.env.INVX_SECRET || '';
  const action    = event.queryStringParameters?.action || 'getData';
  const orderId   = event.queryStringParameters?.id     || '';

  if (!apiKey) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Missing api-key' }),
    };
  }

  const INVX_ACCOUNT = process.env.INVX_ACCOUNT || '';
  if (!INVX_ACCOUNT) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'INVX_ACCOUNT env var not set' }) };
  }

  // Settrade Open API paths (sdk: settrade_v2/equity.py → InvestorEquity)
  const STTRADE_HOST = 'https://open-api.settrade.com';
  const ACCT_BASE    = `${STTRADE_HOST}/api/seos/v3/023/accounts/${INVX_ACCOUNT}`;

  try {
    // ── PING / TEST — login + portfolio to verify connectivity ──
    if (action === 'ping') {
      try {
        const { token, tokenType } = await settradeLogin(apiKey, apiSecret, '023', 'ALGO_EQ');
        const port = await authGet(ACCT_BASE + '/portfolios', token, tokenType);
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({
          status: 'ok', login: 'success', portfolio_url: ACCT_BASE + '/portfolios', portfolio: port,
        }) };
      } catch(e) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'error', error: e.message }) };
      }
    }

    // ── DEBUG — shows raw response + normalize result ──
    if (action === 'debug') {
      const { token, tokenType } = await settradeLogin(apiKey, apiSecret, '023', 'ALGO_EQ');
      const raw = await authGet(ACCT_BASE + '/portfolios', token, tokenType);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({
        url_used: ACCT_BASE + '/portfolios',
        raw_type: typeof raw,
        raw_is_array: Array.isArray(raw),
        raw_keys: typeof raw === 'object' && raw !== null ? Object.keys(raw) : [],
        raw_data_keys: raw?.data ? Object.keys(raw.data) : [],
        sample: Array.isArray(raw) ? raw.slice(0,2) : (raw?.data?.positions || raw?.positions || raw?.data || raw),
        normalized: normalizePortfolio(raw),
        cash: extractCash(raw),
      })};
    }

    // ── GET PORTFOLIO + PRICES ──
    if (action === 'getData') {
      const { token, tokenType } = await settradeLogin(apiKey, apiSecret, '023', 'ALGO_EQ');
      const [port, orders] = await Promise.allSettled([
        authGet(ACCT_BASE + '/portfolios', token, tokenType),
        authGet(ACCT_BASE + '/orders', token, tokenType),
      ]);

      const rawPort = port.status === 'fulfilled' ? port.value : null;
      const portfolio = rawPort ? normalizePortfolio(rawPort) : [];
      const ordersData = orders.status === 'fulfilled' ? normalizeOrders(orders.value) : [];
      const cash = extractCash(rawPort);

      if (rawPort && portfolio.length === 0) {
        console.warn('[invx] Portfolio empty — raw keys:', Object.keys(rawPort || {}).join(','));
      }

      // Fetch real-time prices from Settrade (Thai market data)
      if (portfolio.length > 0) {
        const syms = portfolio.map(p => p.sym).join(',');
        try {
          const priceData = await httpGet(`https://api.settrade.com/api/quotes/stocks?symbol=${syms}`);
          const parsed = JSON.parse(priceData);
          if (parsed.stocks) {
            const priceMap = {};
            parsed.stocks.forEach(s => { if(s.last || s.prior) priceMap[s.symbol] = s.last || s.prior; });
            portfolio.forEach(p => { if (priceMap[p.sym]) p.mkt = Number(priceMap[p.sym]); });
          }
        } catch(e) { /* Settrade unavailable — keep InnovestX prices */ }
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ portfolio, orders: ordersData, cash }),
      };
    }

    // ── CANCEL ORDER ──
    if (action === 'cancel' && orderId) {
      const { token, tokenType } = await settradeLogin(apiKey, apiSecret, '023', 'ALGO_EQ');
      const body = event.body ? JSON.parse(event.body) : {};
      const pin = body.pin || process.env.INVX_PIN || '';
      const cancelBody = pin ? { pin: String(pin) } : {};
      const res = await authPatch(ACCT_BASE + '/orders/' + orderId + '/cancel', token, tokenType, cancelBody);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'cancelled', data: res }) };
    }

    // ── STOCK QUOTE (Settrade) ──
    if (action === 'quote') {
      const sym = (event.queryStringParameters?.sym || '').toUpperCase().trim();
      if (!sym) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing sym' }) };
      try {
        const raw = await httpGet(`https://api.settrade.com/api/quotes/stocks?symbol=${sym}`);
        const parsed = JSON.parse(raw);
        const s = (parsed.stocks || [])[0] || {};
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({
          sym,
          last:   Number(s.last   || s.Last   || 0),
          high:   Number(s.high   || s.High   || s.dailyHigh  || 0),
          low:    Number(s.low    || s.Low    || s.dailyLow   || 0),
          bid:    Number(s.bid    || s.Bid    || s.bestBid    || 0),
          ask:    Number(s.ask    || s.Ask    || s.offer      || s.bestOffer || 0),
          prior:  Number(s.prior  || 0),
          change: Number(s.change || s.priceChange || 0),
          pct:    Number(s.percentChange || s.changePct || 0),
          volume: Number(s.volume || s.totalVolume || 0),
        }) };
      } catch(e) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sym, last: 0, error: 'unavailable' }) };
      }
    }

    // ── PLACE ORDER ──
    if (event.httpMethod === 'POST' && action === 'order') {
      const INVX_PIN = process.env.INVX_PIN || '';

      // Settrade Open API uses "Buy"/"Sell" and specific field names
      const rawSide = (body.side || 'Sell').toLowerCase();
      const settradeSide = rawSide.startsWith('b') ? 'Buy' : 'Sell';

      const sym = body.ticker || body.symbol || '';
      const qty = Number(body.quantity || body.qty || 0);
      const price = Number(body.price || 0);

      // Settrade Open API order body (from official SDK docs)
      const orderBody = {
        symbol:         sym,
        side:           settradeSide,   // "Buy" or "Sell"
        priceType:      price > 0 ? 'Limit' : 'ATO',
        validityType:   'Day',
        trusteeIdType:  'Local',
        volume:         qty,
        bypassWarning:  '',
      };
      if (price > 0) orderBody.price = price;

      // PIN: from request body (user-entered in modal) OR env var (server-side)
      const pin = body.pin || INVX_PIN;
      if (pin) orderBody.pin = String(pin);

      const orderUrl = ACCT_BASE + '/orders';
      console.log('[invx] Placing order to:', orderUrl);
      console.log('[invx] Order body:', JSON.stringify({ ...orderBody, pin: pin ? '***' : undefined }));

      const { token: orderToken, tokenType: orderTokenType } = await settradeLogin(apiKey, apiSecret, '023', 'ALGO_EQ');
      const invxResp = await authPost(orderUrl, orderToken, orderTokenType, orderBody);
      const httpStatus = invxResp.statusCode;
      const res = invxResp.body;
      console.log('[invx] InnovestX HTTP status:', httpStatus, 'redirect:', invxResp.location);
      console.log('[invx] InnovestX response:', typeof res === 'string' ? res.slice(0, 500) : JSON.stringify(res));

      // Detect success — InnovestX may return orderId / orderNo / data.orderId
      const isSuccess =
        httpStatus >= 200 && httpStatus < 300 &&
        !!(res?.orderId || res?.order_id || res?.orderNo ||
           res?.data?.orderId || res?.data?.order_id ||
           res?.status === 'success' || res?.success === true);

      // Extract best error message from response
      const bodyErr = (typeof res === 'object' && res !== null)
        ? (res.message || res.error || res.detail || res.errorMessage || JSON.stringify(res).slice(0, 300))
        : (typeof res === 'string' ? res.slice(0, 300) : '');
      const invxErr = `HTTP ${httpStatus} [${orderUrl}]${invxResp.location ? ' → ' + invxResp.location : ''}: ${bodyErr}`;

      return {
        statusCode: isSuccess ? 200 : 400,
        headers: corsHeaders,
        body: JSON.stringify({
          ...(typeof res === 'object' && res !== null ? res : {}),
          _success:     isSuccess,
          _http_status: httpStatus,
          _error_msg:   isSuccess ? '' : invxErr,
          _raw:         res,
        }),
      };
    }

    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

// ── HTTP HELPERS ──
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'EarthhEvans-Bot/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── NORMALIZE Settrade response → Dashboard format ──
function normalizePortfolio(raw) {
  let items;
  if (Array.isArray(raw))                          items = raw;
  else if (Array.isArray(raw?.portfolioList))      items = raw.portfolioList;
  else if (Array.isArray(raw?.data?.portfolioList))items = raw.data.portfolioList;
  else if (Array.isArray(raw?.data?.positions))    items = raw.data.positions;
  else if (Array.isArray(raw?.positions))          items = raw.positions;
  else if (Array.isArray(raw?.data))               items = raw.data;
  else                                             items = [];

  return items
    .filter(p => p.symbol && p.symbol !== 'TOTAL')
    .map(p => ({
      sym: p.symbol || '',
      qty: Number(p.actualVolume || p.currentVolume || p.volume || p.quantity || 0),
      avg: Number(p.averagePrice || p.avgCost || p.avg_cost || 0),
      mkt: Number(p.marketPrice  || p.lastPrice  || p.last   || 0),
    }))
    .filter(p => p.sym && p.qty > 0);
}

function extractCash(raw) {
  if (!raw) return 0;
  const d = raw?.data || raw;
  // Settrade portfolios response: totalAmount field at root, or TOTAL row in portfolioList
  const total = d?.totalAmount || d?.cashBalance || d?.cash || d?.availableCash ||
    d?.totalCash || d?.free_cash || raw?.cashBalance || 0;
  if (total) return Number(total);
  // Find TOTAL row
  const totalRow = (Array.isArray(d?.portfolioList) ? d.portfolioList : []).find(p => p.symbol === 'TOTAL');
  return totalRow ? Number(totalRow.marketValue || 0) : 0;
}

function normalizeOrders(raw) {
  const items = Array.isArray(raw) ? raw : (raw?.orders || raw?.data || []);
  return items.map(o => ({
    id:      o.orderNo    || o.order_id  || '',
    sym:     o.symbol     || o.ticker    || '',
    side:    (o.side || o.Side || '').toUpperCase() === 'B' ? 'BUY' : 'SELL',
    price:   o.price      || 0,
    qty:     o.volume     || o.quantity  || 0,
    status:  o.status     || 'PENDING',
    trigger: o.condition  || 'Market',
  }));
}
