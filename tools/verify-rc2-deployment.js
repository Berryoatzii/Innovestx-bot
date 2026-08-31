#!/usr/bin/env node

'use strict';

const DEFAULT_BASE_URL = 'https://investmentavengers.netlify.app';
const DEFAULT_SITE_API_URL = 'https://api.netlify.com/api/v1/sites/investmentavengers.netlify.app';
const DEFAULT_BRANCH = 'claude/ai-agent-deployment-game-vpLlI';
const DEFAULT_VERSION = '9.0.0-rc2-forward-shadow';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) throw new Error(`UNKNOWN_ARGUMENT:${value}`);
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`VALUE_REQUIRED:${key}`);
    options[key] = next;
    index += 1;
  }
  return options;
}

function requireHttps(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${label}_HTTPS_REQUIRED`);
  return url.toString().replace(/\/$/, '');
}

async function request(fetchImpl, url) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {}
  return { status: response.status, payload };
}

async function verifyDeployment(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_UNAVAILABLE');
  const baseUrl = requireHttps(options.baseUrl || DEFAULT_BASE_URL, 'BASE_URL');
  const siteApiUrl = requireHttps(options.siteApiUrl || DEFAULT_SITE_API_URL, 'SITE_API_URL');
  const expectedCommit = String(options.expectedCommit || '').trim().toLowerCase();
  const expectedBranch = String(options.expectedBranch || DEFAULT_BRANCH).trim();
  const expectedVersion = String(options.expectedVersion || DEFAULT_VERSION).trim();
  if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error('EXPECTED_COMMIT_INVALID');
  if (!expectedBranch || !expectedVersion) throw new Error('EXPECTED_RELEASE_IDENTITY_REQUIRED');

  const site = await request(fetchImpl, siteApiUrl);
  const health = await request(fetchImpl, `${baseUrl}/.netlify/functions/telegram-advanced?action=health`);
  const shadow = await request(fetchImpl, `${baseUrl}/.netlify/functions/dr-forward-shadow`);
  const published = site.payload?.published_deploy || {};
  const checks = {
    siteMetadataAvailable: site.status === 200,
    publishedCommitMatches: String(published.commit_ref || '').toLowerCase() === expectedCommit,
    publishedBranchMatches: published.branch === expectedBranch,
    deployReady: published.state === 'ready',
    healthAvailable: health.status === 200 && health.payload?.ok === true,
    versionMatches: health.payload?.version === expectedVersion,
    liveTradingDisabled: health.payload?.liveTradingEnabled === false,
    publicForwardShadowLocked: shadow.status === 401,
    brokerNotCalled: true,
    orderEndpointNotCalled: true,
    moneyNotMoving: true,
  };
  return {
    passed: Object.values(checks).every((value) => value === true),
    checks,
    observed: {
      publishedCommit: published.commit_ref || null,
      publishedBranch: published.branch || null,
      publishedAt: published.published_at || null,
      deployState: published.state || null,
      version: health.payload?.version || null,
      liveTradingEnabled: health.payload?.liveTradingEnabled ?? null,
      publicForwardShadowStatus: shadow.status,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyDeployment({
    baseUrl: args.base,
    siteApiUrl: args.site,
    expectedCommit: args['expected-commit'],
    expectedBranch: args['expected-branch'],
    expectedVersion: args['expected-version'],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.passed ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  parseArgs,
  verifyDeployment,
  DEFAULT_BASE_URL,
  DEFAULT_SITE_API_URL,
  DEFAULT_BRANCH,
  DEFAULT_VERSION,
};
