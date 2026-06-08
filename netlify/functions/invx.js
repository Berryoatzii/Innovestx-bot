// Netlify Function: /api/invx
// Proxy ระหว่าง Browser กับ InnovestX API (แก้ CORS)
// Deploy ที่ Netlify → เรียก /.netlify/functions/invx

const https = require('https');

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

  const INVX_BASE = 'https://trade.innovestx.co.th/api/api-portal/v1/equity/';

  try {
    // ── PING / TEST ──
    if (action === 'ping') {
      const res = await invxGet(INVX_BASE + apiKey + '/portfolio', apiKey, apiSecret);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'ok', data: res }) };
    }

    // ── DEBUG — shows raw InnovestX response to diagnose field mapping ──
    if (action === 'debug') {
      const raw = await invxGet(INVX_BASE + apiKey + '/portfolio', apiKey, apiSecret);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({
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
      const [port, orders] = await Promise.allSettled([
        invxGet(INVX_BASE + apiKey + '/portfolio', apiKey, apiSecret),
        invxGet(INVX_BASE + apiKey + '/orders?status=pending', apiKey, apiSecret),
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
      const res = await invxDelete(INVX_BASE + apiKey + '/orders/' + orderId, apiKey, apiSecret);
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

      // InnovestX uses 'B'/'S' — inferred from normalizeOrders() which reads their response side field
      const rawSide = (body.side || 'Sell').toLowerCase();
      const invxSide = rawSide.startsWith('b') ? 'B' : 'S';

      const sym = body.ticker || body.symbol || '';
      const qty = Number(body.quantity || body.qty || 0);
      const price = Number(body.price || 0);

      // Send both naming conventions — InnovestX will use whichever it recognises
      const orderBody = {
        symbol:     sym,       // InnovestX standard field (from their response schema)
        ticker:     sym,       // alternate alias
        side:       invxSide,  // 'B' or 'S'
        volume:     qty,       // InnovestX standard field
        quantity:   qty,       // alternate alias
        order_type: body.order_type || 'MP-MTL',
        api_secret: apiSecret,
      };
      if (price > 0) orderBody.price = price;

      // PIN: from request body (user-entered in modal) OR env var (server-side)
      const pin = body.pin || INVX_PIN;
      if (pin) orderBody.pin = String(pin);

      const orderUrl = INVX_BASE + apiKey + '/orders';
      console.log('[invx] Placing order to:', orderUrl);
      console.log('[invx] Order body:', JSON.stringify({ ...orderBody, api_secret: '***', pin: pin ? '***' : undefined }));

      // POST to /equity/{apiKey}/orders — consistent with cancel DELETE /orders/{id}
      const invxResp = await invxPost(orderUrl, apiKey, apiSecret, orderBody);
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

function invxGet(url, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'api-key': apiKey, 'api-secret': apiSecret, 'Accept': 'application/json' },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function invxPost(url, apiKey, apiSecret, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'api-key': apiKey, 'api-secret': apiSecret,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const statusCode = res.statusCode;
        const location = res.headers?.location || '';
        try {
          resolve({ statusCode, location, body: JSON.parse(data) });
        } catch(e) {
          resolve({ statusCode, location, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function invxDelete(url, apiKey, apiSecret) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'DELETE',
      headers: { 'api-key': apiKey, 'api-secret': apiSecret },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── NORMALIZE InnovestX response → Dashboard format ──
function normalizePortfolio(raw) {
  // Handle all known InnovestX response shapes
  let items;
  if (Array.isArray(raw)) {
    items = raw;
  } else if (Array.isArray(raw?.data?.positions)) {
    items = raw.data.positions;
  } else if (Array.isArray(raw?.data)) {
    items = raw.data;
  } else if (Array.isArray(raw?.positions)) {
    items = raw.positions;
  } else if (Array.isArray(raw?.portfolio)) {
    items = raw.portfolio;
  } else {
    items = [];
  }

  return items.map(p => {
    const avg = Number(p.avgCost || p.avg_cost || p.AvgCost || p.averageCost || p.costPrice || 0);
    const mkt = Number(p.lastPrice || p.last || p.Last || p.marketPrice || p.currentPrice || avg);
    const qty = Number(p.volume || p.quantity || p.Volume || p.availableVolume || p.actualVolume || 0);
    return {
      sym: p.symbol || p.ticker || p.Symbol || p.stockCode || '',
      qty,
      avg,
      mkt,
    };
  }).filter(p => p.sym && p.qty > 0);
}

function extractCash(raw) {
  if (!raw) return 0;
  const d = raw?.data || raw;
  return Number(
    d?.cashBalance || d?.cash || d?.availableCash || d?.cashAvailable ||
    d?.totalCash || d?.free_cash || raw?.cashBalance || 0
  );
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
