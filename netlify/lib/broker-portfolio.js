const { handler: invxHandler } = require('../functions/invx');

async function fetchBrokerPortfolio(event) {
  const response = await invxHandler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { action: 'getData' },
    body: '',
    requestContext: event?.requestContext,
  });
  let payload = {};
  try { payload = JSON.parse(response.body || '{}'); }
  catch { throw new Error('BROKER_PORTFOLIO_INVALID_JSON'); }
  if (response.statusCode !== 200) {
    throw new Error(`BROKER_PORTFOLIO_HTTP_${response.statusCode}:${payload.error || 'UNKNOWN'}`);
  }
  return {
    portfolio: Array.isArray(payload.portfolio) ? payload.portfolio : [],
    orders: Array.isArray(payload.orders) ? payload.orders : [],
    cash: Number(payload.cash || 0),
    raw: payload,
  };
}

module.exports = { fetchBrokerPortfolio };
