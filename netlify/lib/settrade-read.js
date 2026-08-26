const { gatewayRequest } = require('./broker-gateway-client');

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
    quantity: Number(order.vol || order.volume || order.quantity || order.qty || 0),
    matchedQuantity: Number(order.matched ?? order.matchQty ?? order.matchedVolume ?? order.matchedQuantity ?? order.executedVolume ?? 0),
    status: String(order.status || order.orderStatus || 'UNKNOWN').toUpperCase(),
    entryTime: order.entryTime || order.transactionTime || order.tradeTime || order.orderTime || null,
    canCancel: order.canCancel === true,
  }));
}

async function fetchRawOrders() {
  // All account reads use the same official SDK session owner. The Node layer
  // never receives an App Secret or PIN and never logs into Settrade directly.
  const payload = await gatewayRequest('/v1/orders');
  return normalizeRawOrders(payload?.orders || []);
}

module.exports = {
  fetchRawOrders,
  normalizeRawOrders,
  _test: { normalizeSide },
};
