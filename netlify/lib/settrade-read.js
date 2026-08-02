const https = require('https');
const crypto = require('crypto');

const PKCS8_P256_PREFIX = Buffer.from(
  '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420',
  'hex'
);

function signSettrade(appId, appSecret, params = '') {
  const timestamp = Date.now().toString();
  const content = `${appId}.${params}.${timestamp}`;
  const rawKey = Buffer.from(appSecret, 'base64');
  const pkcs8 = Buffer.concat([PKCS8_P256_PREFIX, rawKey]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const signer = crypto.createSign('SHA256');
  signer.update(content, 'utf8');
  return { signature: signer.sign(privateKey, 'hex'), timestamp };
}

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ statusCode: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('SETTRADE_READ_TIMEOUT'));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function login() {
  const appId = process.env.INVX_KEY || '';
  const appSecret = process.env.INVX_SECRET || '';
  if (!appId || !appSecret) throw new Error('INVX_CREDENTIALS_MISSING');

  const { signature, timestamp } = signSettrade(appId, appSecret);
  const body = JSON.stringify({ apiKey: appId, params: '', signature, timestamp });
  const response = await requestJson({
    hostname: 'open-api.settrade.com',
    path: '/api/oam/v1/023/broker-apps/ALGO_EQ/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Accept': 'application/json',
    },
  }, body);

  if (response.statusCode < 200 || response.statusCode >= 300 || !response.body?.access_token) {
    throw new Error(`SETTRADE_LOGIN_FAILED:${response.statusCode}`);
  }
  return {
    token: response.body.access_token,
    tokenType: response.body.token_type || 'Bearer',
  };
}

async function authenticatedGet(path) {
  const account = process.env.INVX_ACCOUNT || '';
  if (!account) throw new Error('INVX_ACCOUNT_MISSING');
  const { token, tokenType } = await login();
  const response = await requestJson({
    hostname: 'open-api.settrade.com',
    path: `/api/seos/v3/023/accounts/${account}${path}`,
    method: 'GET',
    headers: {
      'Authorization': `${tokenType} ${token}`,
      'Accept': 'application/json',
    },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`SETTRADE_GET_FAILED:${response.statusCode}:${path}`);
  }
  return response.body;
}

function normalizeSide(side) {
  const value = String(side || '').toUpperCase();
  if (value === 'B' || value === 'BUY') return 'BUY';
  if (value === 'S' || value === 'SELL') return 'SELL';
  return value;
}

function normalizeRawOrders(raw) {
  let items = [];
  if (Array.isArray(raw)) items = raw;
  else if (Array.isArray(raw?.orders)) items = raw.orders;
  else if (Array.isArray(raw?.orderList)) items = raw.orderList;
  else if (Array.isArray(raw?.data?.orders)) items = raw.data.orders;
  else if (Array.isArray(raw?.data?.orderList)) items = raw.data.orderList;
  else if (Array.isArray(raw?.data)) items = raw.data;

  return items.map((order) => ({
    id: order.orderNo || order.orderId || order.order_id || order.id || '',
    symbol: String(order.symbol || order.ticker || '').toUpperCase(),
    side: normalizeSide(order.side || order.Side),
    price: Number(order.price || order.orderPrice || 0),
    quantity: Number(order.volume || order.quantity || order.qty || 0),
    matchedQuantity: Number(order.matchedVolume || order.matchedQuantity || order.executedVolume || 0),
    status: String(order.status || order.orderStatus || 'UNKNOWN').toUpperCase(),
    raw: order,
  }));
}

async function fetchRawOrders() {
  return normalizeRawOrders(await authenticatedGet('/orders'));
}

module.exports = {
  fetchRawOrders,
  normalizeRawOrders,
  _test: { normalizeSide, signSettrade },
};
