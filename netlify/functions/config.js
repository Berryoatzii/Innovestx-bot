// Public non-sensitive capability status. Secret values never leave server.
exports.handler = async (event = {}) => {
  const cors = {
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'null',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }
  const brokerGatewayEnvironment = String(process.env.BROKER_GATEWAY_ENVIRONMENT || '').toLowerCase();
  const brokerGatewayReady = Boolean(
    process.env.BROKER_GATEWAY_URL
      && process.env.BROKER_GATEWAY_TOKEN
      && ['uat', 'prod'].includes(brokerGatewayEnvironment)
  );
  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({
      brokerGatewayReady,
      brokerGatewayEnvironment: brokerGatewayEnvironment || null,
      geminiReady: Boolean(process.env.GEMINI_API_KEY),
      telegramReady: Boolean(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
    }),
  };
};
