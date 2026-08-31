const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../netlify/functions/telegram-advanced');

test('deployment version identifies RC2 forward shadow and defaults live trading off', () => {
  const previousLiveTrading = process.env.LIVE_TRADING_ENABLED;
  delete process.env.LIVE_TRADING_ENABLED;

  try {
    assert.equal(_test.APP_VERSION, '9.0.0-rc2-forward-shadow');
    assert.equal(_test.deploymentInfo().liveTradingEnabled, false);
  } finally {
    if (previousLiveTrading === undefined) {
      delete process.env.LIVE_TRADING_ENABLED;
    } else {
      process.env.LIVE_TRADING_ENABLED = previousLiveTrading;
    }
  }
});
