const test = require('node:test');
const assert = require('node:assert/strict');

function clearRuntime() {
  delete process.env.NETLIFY_BLOBS_CONTEXT;
  delete process.env.NETLIFY_BLOBS_SITE_ID;
  delete process.env.NETLIFY_BLOBS_TOKEN;
  delete globalThis.netlifyBlobsContext;
  try { delete require.cache[require.resolve('../netlify/lib/blob-runtime')]; } catch {}
}

test.beforeEach(clearRuntime);
test.after(clearRuntime);

function encodedContext(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

test('edge-only Lambda context does not claim strong consistency support', () => {
  const { runtimeContext, strongConsistencyAvailable } = require('../netlify/lib/blob-runtime');
  const event = {
    blobs: encodedContext({
      siteID: 'site-test',
      token: 'token-test',
      edgeURL: 'https://edge.example.test',
    }),
    headers: {},
  };

  assert.equal(runtimeContext(event).edgeURL, 'https://edge.example.test');
  assert.equal(strongConsistencyAvailable(event), false);
});

test('uncached edge endpoint enables strong consistency support', () => {
  const { strongConsistencyAvailable } = require('../netlify/lib/blob-runtime');
  const event = {
    blobs: encodedContext({
      siteID: 'site-test',
      token: 'token-test',
      edgeURL: 'https://edge.example.test',
      uncachedEdgeURL: 'https://uncached.example.test',
    }),
    headers: {},
  };

  assert.equal(strongConsistencyAvailable(event), true);
});

test('strong store access fails closed when runtime lacks an uncached endpoint', async () => {
  const { openBlobStore } = require('../netlify/lib/blob-runtime');
  await assert.rejects(
    () => openBlobStore('test-store', { consistency: 'strong' }),
    /BLOBS_STRONG_CONSISTENCY_UNAVAILABLE/
  );
});

test('runtime error from screenshot is recognized as a strong consistency problem', () => {
  const { isStrongConsistencyError } = require('../netlify/lib/blob-runtime');
  assert.equal(isStrongConsistencyError(new Error(
    "Netlify Blobs has failed to perform a read using strong consistency because the environment has not been configured with a 'uncachedEdgeURL' property"
  )), true);
});
