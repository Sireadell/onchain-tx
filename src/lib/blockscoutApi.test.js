import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTokenInfo, resetBlockscoutCache, TokenNotFoundError } from './blockscoutApi.js';

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url === 'string' && url.includes('.blockscout.com')) {
      return handler(url, ...rest);
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('returns holder count on success', async (t) => {
  resetBlockscoutCache();
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({ holders_count: '42', name: 'USD Coin', symbol: 'USDC', decimals: '6' }),
  }));

  const info = await getTokenInfo('eth.blockscout.com', '0x' + 'a'.repeat(40));
  assert.equal(info.holdersCount, '42');
  assert.equal(info.symbol, 'USDC');
});

test('404 throws TokenNotFoundError, not retried', async (t) => {
  resetBlockscoutCache();
  let callCount = 0;
  mockFetch(t, async () => {
    callCount += 1;
    return { status: 404, statusText: 'Not Found', json: async () => ({}) };
  });

  await assert.rejects(
    () => getTokenInfo('eth.blockscout.com', '0x' + 'b'.repeat(40)),
    (err) => err instanceof TokenNotFoundError
  );
  assert.equal(callCount, 1);
});

test('429 is retried, then succeeds', async (t) => {
  resetBlockscoutCache();
  let callCount = 0;
  mockFetch(t, async () => {
    callCount += 1;
    if (callCount < 2) return { status: 429, statusText: 'Too Many Requests', json: async () => ({}) };
    return { status: 200, json: async () => ({ holders_count: '7' }) };
  });

  const info = await getTokenInfo('eth.blockscout.com', '0x' + 'c'.repeat(40));
  assert.equal(info.holdersCount, '7');
  assert.equal(callCount, 2);
});

test('cache avoids a second network call for the same host+address', async (t) => {
  resetBlockscoutCache();
  let callCount = 0;
  mockFetch(t, async () => {
    callCount += 1;
    return { status: 200, json: async () => ({ holders_count: '99' }) };
  });

  const address = '0x' + 'd'.repeat(40);
  await getTokenInfo('eth.blockscout.com', address);
  await getTokenInfo('eth.blockscout.com', address);
  assert.equal(callCount, 1);
});
