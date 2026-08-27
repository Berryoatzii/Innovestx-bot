// Central Netlify Blobs runtime adapter.
//
// Lambda-compatible Netlify Functions must call connectLambda(event) before
// getStore(). Some older/runtime contexts provide edgeURL but not
// uncachedEdgeURL, which makes strong-consistency reads fail. Operator and
// research stores may safely fall back to eventual consistency. Money-moving
// state transitions must explicitly require strong consistency and fail closed.

let modulePromise = null;
let lastLambdaContext = null;

function loadBlobs() {
  if (!modulePromise) modulePromise = import('@netlify/blobs');
  return modulePromise;
}

function getHeader(headers, name) {
  const target = String(name).toLowerCase();
  const match = Object.entries(headers || {}).find(([key]) => String(key).toLowerCase() === target);
  return match ? match[1] : '';
}

function decodeContext(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const text = String(value);

  try {
    return JSON.parse(text);
  } catch {}

  try {
    return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
  } catch {}

  return null;
}

function runtimeContext(event) {
  const eventValue = event?.blobs ||
    getHeader(event?.headers, 'x-nf-blobs-context') ||
    getHeader(event?.headers, 'x-netlify-blobs-context');

  return decodeContext(eventValue) ||
    decodeContext(globalThis.netlifyBlobsContext) ||
    decodeContext(process.env.NETLIFY_BLOBS_CONTEXT);
}

function directApiOptions(event) {
  const context = runtimeContext(event) || {};
  const siteID = context.siteID || process.env.NETLIFY_BLOBS_SITE_ID;
  const token = context.token || process.env.NETLIFY_BLOBS_TOKEN;
  if (!siteID || !token) return null;
  return {
    siteID,
    token,
    ...(context.apiURL ? { apiURL: context.apiURL } : {}),
  };
}

function strongConsistencyAvailable(event) {
  const context = runtimeContext(event);
  return Boolean(
    context?.uncachedEdgeURL ||
    context?.apiURL ||
    directApiOptions(event)
  );
}

async function initializeLambdaContext(event) {
  const mod = await loadBlobs();
  const contextKey = event?.blobs ||
    getHeader(event?.headers, 'x-nf-blobs-context') ||
    getHeader(event?.headers, 'x-netlify-blobs-context') ||
    null;

  // connectLambda is required only for Lambda compatibility mode. Re-run it
  // whenever the platform context changes; tokens may rotate between invocations.
  if (contextKey && contextKey !== lastLambdaContext && typeof mod.connectLambda === 'function') {
    mod.connectLambda(event);
    lastLambdaContext = contextKey;
  }

  return mod;
}

async function openBlobStore(name, options = {}) {
  const event = options.event;
  const consistency = options.consistency || 'eventual';
  const mod = await initializeLambdaContext(event);

  if (consistency === 'strong') {
    if (!strongConsistencyAvailable(event)) {
      const error = new Error('BLOBS_STRONG_CONSISTENCY_UNAVAILABLE');
      error.code = 'BLOBS_STRONG_CONSISTENCY_UNAVAILABLE';
      throw error;
    }
    // Lambda compatibility contexts can contain an authenticated edge client
    // without an uncachedEdgeURL. In that case the SDK rejects strong reads
    // before making a request. Supplying the same short-lived site credentials
    // explicitly makes the SDK use Netlify's uncached API endpoint instead.
    // Credentials stay inside the function runtime and are never persisted.
    if (!runtimeContext(event)?.uncachedEdgeURL) {
      const direct = directApiOptions(event);
      if (direct) return mod.getStore({ name, consistency: 'strong', ...direct });
    }
    return mod.getStore({ name, consistency: 'strong' });
  }

  if (consistency === 'prefer-strong' && strongConsistencyAvailable(event)) {
    return mod.getStore({ name, consistency: 'strong' });
  }

  return mod.getStore(name);
}

function readOptions(type = 'json', options = {}) {
  const result = { type };
  if (options.consistency === 'strong') result.consistency = 'strong';
  return result;
}

function isStrongConsistencyError(error) {
  const message = String(error?.message || error || '');
  return error?.code === 'BLOBS_STRONG_CONSISTENCY_UNAVAILABLE' ||
    message.includes('uncachedEdgeURL') ||
    message.includes('strong consistency') ||
    message.includes('BLOBS_STRONG_CONSISTENCY_UNAVAILABLE');
}

module.exports = {
  openBlobStore,
  runtimeContext,
  strongConsistencyAvailable,
  readOptions,
  isStrongConsistencyError,
  _test: { decodeContext, getHeader, directApiOptions },
};
