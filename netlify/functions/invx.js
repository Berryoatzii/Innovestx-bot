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

    // ── GET PORTFOLIO + PRICES ──
    if (action === 'getData') {
      const [port, orders] = await Promise.allSettled([
        invxGet(INVX_BASE + apiKey + '/portfolio', apiKey, apiSecret),
        invxGet(INVX_BASE + apiKey + '/orders?status=pending', apiKey, apiSecret),
      ]);

      const portfolio = port.status === 'fulfilled' ? normalizePortfolio(port.value) : [];
      const ordersData = orders.status === 'fulfilled' ? normalizeOrders(orders.value) : [];

      // ── GET REAL-TIME PRICES from Settrade (public API) ──
      let prices = {};
      if (portfolio.length > 0) {
        const syms = portfolio.map(p => p.sym).join(',');
        try {
          const priceData = await httpGet(`https://api.settrade.com/api/quotes/stocks?symbol=${syms}`);
          const parsed = JSON.parse(priceData);
          if (parsed.stocks) {
            parsed.stocks.forEach(s => { prices[s.symbol] = s.last || s.prior; });
          }
        } catch(e) { /* ถ้า Settrade ไม่ตอบ ใช้ราคาปิดล่าสุดจาก InnovestX */ }
      }

      // Merge prices
      portfolio.forEach(p => {
        if (prices[p.sym]) p.mkt = prices[p.sym];
      });

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ portfolio, orders: ordersData, cash: 45200 }),
      };
    }

    // ── CANCEL ORDER ──
    if (action === 'cancel' && orderId) {
      const res = await invxDelete(INVX_BASE + apiKey + '/orders/' + orderId, apiKey, apiSecret);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: 'cancelled', data: res }) };
    }

    // ── PLACE ORDER ──
    if (event.httpMethod === 'POST' && action === 'order') {
      const res = await invxPost(INVX_BASE + apiKey, apiKey, apiSecret, body);
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(res) };
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
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
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
  // InnovestX portfolio endpoint returns array of positions
  const items = Array.isArray(raw) ? raw : (raw?.positions || raw?.data || []);
  return items.map(p => ({
    sym:  p.symbol   || p.ticker   || p.Symbol  || '',
    qty:  p.volume   || p.quantity || p.Volume  || 0,
    avg:  p.avgCost  || p.avg_cost || p.AvgCost || 0,
    mkt:  p.lastPrice|| p.last     || p.Last    || p.avgCost || 0,
  })).filter(p => p.sym && p.qty > 0);
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
