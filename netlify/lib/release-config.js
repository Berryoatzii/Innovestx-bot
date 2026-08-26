const checkedInFailClosedConfig = require('../../config/real-money-release.json');

function parseRuntimeEvidence(env = process.env) {
  const encoded = String(env.REAL_MONEY_RELEASE_EVIDENCE_B64 || '').trim();
  const plain = String(env.REAL_MONEY_RELEASE_EVIDENCE_JSON || '').trim();
  if (!encoded && !plain) return null;
  const source = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : plain;
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('REAL_MONEY_RELEASE_EVIDENCE_INVALID');
  }
  return parsed;
}

function loadReleaseConfig(env = process.env) {
  try {
    return parseRuntimeEvidence(env) || checkedInFailClosedConfig;
  } catch {
    return checkedInFailClosedConfig;
  }
}

module.exports = { loadReleaseConfig, parseRuntimeEvidence };
