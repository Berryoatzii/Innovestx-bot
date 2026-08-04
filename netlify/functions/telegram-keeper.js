const { diagnoseAndRepair } = require('../lib/telegram-control');

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function response(statusCode, data) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(data) };
}

exports.handler = async (event = {}) => {
  try {
    // Safe public recovery: this function can only point the bot to the fixed
    // PRIMARY_SITE_URL configured on the server. It never accepts a caller URL.
    const force = event.queryStringParameters?.repair === '1' ||
      event.queryStringParameters?.force === '1';
    const diagnostics = await diagnoseAndRepair({ force });
    return response(diagnostics.ok ? 200 : 503, {
      ok: diagnostics.ok,
      service: 'telegram-webhook',
      ...diagnostics,
    });
  } catch (error) {
    return response(500, {
      ok: false,
      service: 'telegram-webhook',
      error: error.message,
    });
  }
};