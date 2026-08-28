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

test('edge-only Lambda context can use authenticated API fallback for strong consistency', () => {
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
  assert.equal(strongConsistencyAvailable(event), true);
});

test('Netlify Lambda compatibility payload combines blob token with site header', () => {
  const { runtimeContext, strongConsistencyAvailable, _test } = require('../netlify/lib/blob-runtime');
  const event = {
    blobs: encodedContext({
      url: 'https://edge.example.test',
      token: 'token-test',
    }),
    headers: {
      'x-nf-site-id': 'site-test',
      'x-nf-deploy-id': 'deploy-test',
    },
  };

  const context = runtimeContext(event);
  assert.equal(context.edgeURL, 'https://edge.example.test');
  assert.equal(context.siteID, 'site-test');
  assert.equal(context.deployID, 'deploy-test');
  assert.deepEqual(_test.directApiOptions(event), {
    siteID: 'site-test',
    token: 'token-test',
  });
  assert.equal(strongConsistencyAvailable(event), true);
});

test('edge-only Lambda context without credentials still fails closed', () => {
  const { strongConsistencyAvailable } = require('../netlify/lib/blob-runtime');
  const event = {
    blobs: encodedContext({ edgeURL: 'https://edge.example.test' }),
    headers: {},
  };

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

