const test = require('node:test');
const assert = require('node:assert/strict');

function clear(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; } catch {}
}

test('Telegram webhook is pinned to the primary Netlify site', () => {
  delete process.env.PRIMARY_SITE_URL;
  clear('../netlify/lib/telegram-control');
  const control = require('../netlify/lib/telegram-control');
  assert.equal(control.PRIMARY_SITE_URL, 'https://investmentavengers.netlify.app');
  assert.equal(
    control.expectedWebhookUrl(),
    'https://investmentavengers.netlify.app/.netlify/functions/telegram'
  );
});

test('Shadow summary never prints undefined date', () => {
  clear('../netlify/functions/strategy-shadow');
  const { _test } = require('../netlify/functions/strategy-shadow');
  const text = _test.buildReportSummary({
    date: '2026-08-05',
    equity: 100000,
    cash: 100000,
    shadowPositions: 0,
    shadowTradeEvents: 0,
    decisionEvents: 0,
    dataQualityFailures: 0,
    setTriValue: 13133.13,
    minimumShadowDays: 20,
    minimumDecisionEvents: 100,
    unclassifiedSymbols: [],
    evaluations: [],
  }, {
    passed: false,
    tradingDays: 2,
    decisionEvents: 0,
  });
  assert.match(text, /RULES SHADOW — 2026-08-05/);
  assert.doesNotMatch(text, /undefined/);
});