const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('RC2 forward shadow is scheduled and has no broker or order-intent dependency', () => {
  const toml = fs.readFileSync(path.resolve(__dirname, '../netlify.toml'), 'utf8');
  const source = fs.readFileSync(
    path.resolve(__dirname, '../netlify/functions/dr-forward-shadow.js'),
    'utf8',
  );

  assert.match(toml, /\[functions\."dr-forward-shadow"\][\s\S]*schedule = "45 1 \* \* 1-5"/);
  assert.equal(source.includes('broker-portfolio'), false);
  assert.equal(source.includes('order-intent-store'), false);
  assert.equal(source.includes('approval-executor'), false);
  assert.equal(source.includes('placeOrder'), false);
});
