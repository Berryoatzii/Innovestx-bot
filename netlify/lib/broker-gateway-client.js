class BrokerGatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'BrokerGatewayError';
    this.statusCode = options.statusCode || 502;
    this.executionUncertain = options.executionUncertain === true;
  }
}

function config() {
  return {
    url: String(process.env.BROKER_GATEWAY_URL || '').replace(/\/+$/, ''),
    token: String(process.env.BROKER_GATEWAY_TOKEN || ''),
    environment: String(process.env.BROKER_GATEWAY_ENVIRONMENT || '').toLowerCase(),
    timeoutMs: Math.max(1000, Number(process.env.BROKER_GATEWAY_TIMEOUT_MS || 12000)),
    productionConfirmation: String(process.env.BROKER_PRODUCTION_CONFIRMATION || ''),
  };
}

function gatewayConfigured() {
  const current = config();
  return Boolean(current.url && current.token && ['uat', 'prod'].includes(current.environment));
}

function isCloudRuntime() {
  return String(process.env.NETLIFY || '').toLowerCase() === 'true'
    || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function validatedBaseUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (local && isCloudRuntime()) {
    throw new BrokerGatewayError('LOCAL_GATEWAY_UNREACHABLE_FROM_CLOUD', { statusCode: 503 });
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new BrokerGatewayError('BROKER_GATEWAY_HTTPS_REQUIRED', { statusCode: 503 });
  }
  return parsed.toString().replace(/\/$/, '');
}

function safeBody(value = {}) {
  const clean = { ...value };
  for (const key of ['pin', 'api_key', 'api_secret', 'appSecret', 'app_secret']) delete clean[key];
  return clean;
}

async function gatewayRequest(path, options = {}) {
  const current = config();
  if (!gatewayConfigured()) {
    throw new BrokerGatewayError('BROKER_GATEWAY_NOT_CONFIGURED', { statusCode: 503 });
  }
  const baseUrl = validatedBaseUrl(current.url);
  const method = String(options.method || 'GET').toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), current.timeoutMs);
  const headers = {
    Authorization: `Bearer ${current.token}`,
    Accept: 'application/json',
  };
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    headers['X-Idempotency-Key'] = String(options.requestId || '');
    if (current.environment === 'prod') {
      if (!current.productionConfirmation) {
        clearTimeout(timer);
        throw new BrokerGatewayError('BROKER_PRODUCTION_CONFIRMATION_NOT_CONFIGURED', { statusCode: 503 });
      }
      headers['X-Production-Confirmation'] = current.productionConfirmation;
    }
    body = JSON.stringify(safeBody(options.body));
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (payload.environment !== current.environment) {
      throw new BrokerGatewayError('BROKER_GATEWAY_ENVIRONMENT_MISMATCH', { statusCode: 503 });
    }
    if (!response.ok || payload.ok !== true) {
      throw new BrokerGatewayError(payload.error || `BROKER_GATEWAY_HTTP_${response.status}`, {
        statusCode: response.status,
        executionUncertain: payload.executionUncertain === true,
      });
    }
    return payload.data;
  } catch (error) {
    if (error instanceof BrokerGatewayError) throw error;
    if (error?.name === 'AbortError') {
      throw new BrokerGatewayError('BROKER_GATEWAY_TIMEOUT', {
        statusCode: 504,
        executionUncertain: method !== 'GET' && method !== 'HEAD',
      });
    }
    throw new BrokerGatewayError('BROKER_GATEWAY_UNREACHABLE', {
      statusCode: 502,
      executionUncertain: method !== 'GET' && method !== 'HEAD',
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  BrokerGatewayError,
  gatewayConfigured,
  gatewayRequest,
  isCloudRuntime,
  safeBody,
  validatedBaseUrl,
};
