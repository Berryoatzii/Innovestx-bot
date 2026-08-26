const test = require('node:test');
const assert = require('node:assert/strict');

const { collectBlobRefs } = require('../netlify/lib/order-intent-store');

test('order intent listing consumes every paginated blob page', async () => {
  const calls = [];
  const store = {
    list(options) {
      calls.push(options);
      return (async function* pages() {
        yield { blobs: [{ key: 'intent/a.json' }], directories: [] };
        yield { blobs: [{ key: 'intent/b.json' }, { key: 'intent/c.json' }], directories: [] };
      })();
    },
  };

  const refs = await collectBlobRefs(store, 'intent/');
  assert.deepEqual(refs.map(item => item.key), [
    'intent/a.json', 'intent/b.json', 'intent/c.json',
  ]);
  assert.deepEqual(calls, [{ prefix: 'intent/', paginate: true }]);
});
