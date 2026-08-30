const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../netlify/functions/bot-readiness');

test('ordinary HTTP readiness reads are not treated as scheduled notifications', () => {
  assert.equal(_test.isScheduledInvocation({ httpMethod: 'GET', headers: {} }), false);
  assert.equal(_test.isScheduledInvocation({ next_run: '2026-08-31T17:30:00+07:00' }), true);
  assert.equal(_test.isScheduledInvocation({ triggerSource: 'schedule' }), true);
  assert.equal(_test.isScheduledInvocation({ headers: { 'X-Netlify-Event': 'schedule' } }), true);
});

test('detailed readiness requires the configured admin token', () => {
  const previous = process.env.ADMIN_TOKEN;
  try {
    delete process.env.ADMIN_TOKEN;
    assert.equal(_test.isDetailedReadAuthorized({ headers: { 'x-admin-token': 'anything' } }), false);

    process.env.ADMIN_TOKEN = 'readiness-test-token';
    assert.equal(_test.isDetailedReadAuthorized({ headers: { 'x-admin-token': 'wrong' } }), false);
    assert.equal(_test.isDetailedReadAuthorized({ headers: { 'X-Admin-Token': 'readiness-test-token' } }), true);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previous;
  }
});

test('public readiness omits broker, cash, positions, approvals, and private rows', () => {
  const result = _test.publicReadiness({
    generatedAt: '2026-08-31T08:00:00+07:00',
    stages: { research: 'READY' },
    telegramReady: true,
    broker: { cash: 7316.23, positions: [{ symbol: 'SECRET' }] },
    classification: { complete: true, rows: [{ symbol: 'SECRET' }] },
    coreEvidence: { passed: 4, total: 5, rows: [{ symbol: 'SECRET' }] },
    activeResearch: { passed: 2, total: 3, rows: [{ symbol: 'SECRET' }] },
    shadowGate: {
      passed: false,
      tradingDays: 3,
      decisionEvents: 12,
      tradeEvents: 2,
      benchmarkCoverage: 0.95,
      shadowReturn: 0.01,
      benchmarkReturn: 0.005,
      excessReturn: 0.005,
      worstDrawdown: -0.02,
      checks: { minTradingDays: false },
      latest: { symbol: 'SECRET' },
    },
    drForwardShadow: {
      passed: false,
      tradingDays: 3,
      instrumentDecisionEvents: 18,
      rebalanceEvents: 1,
      dataErrors: 0,
    },
    approval: { ready: false, callbacks: [{ userId: 'SECRET' }] },
    releaseEvidence: { passed: false, blockers: ['RELEASE_STRATEGY_RELEASE_APPROVED'], private: 'SECRET' },
  });

  assert.equal(result.liveTradingEnabled, false);
  assert.equal(result.classificationComplete, true);
  assert.equal(result.drForwardShadow.tradingDays, 3);
  assert.equal(result.drForwardShadow.instrumentDecisionEvents, 18);
  assert.deepEqual(result.releaseEvidence.blockers, ['RELEASE_STRATEGY_RELEASE_APPROVED']);
  assert.equal(Object.hasOwn(result, 'broker'), false);
  assert.equal(Object.hasOwn(result, 'approval'), false);
  assert.equal(Object.hasOwn(result.shadowGate, 'latest'), false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
