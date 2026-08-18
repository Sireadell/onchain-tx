import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProtocolTvl,
  getChainTvl,
  resetDefiLlamaCache,
  ProtocolNotFoundError,
  ChainNotFoundError,
} from './defiLlamaApi.js';

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url === 'string' && url.includes('api.llama.fi')) {
      return handler(url, ...rest);
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('getProtocolTvl: returns numeric TVL on success', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({
    status: 200,
    text: async () => '2948648103.30746',
  }));

  const tvl = await getProtocolTvl('uniswap');
  assert.equal(tvl, 2948648103.30746);
});

test('getProtocolTvl: unknown protocol throws ProtocolNotFoundError', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({
    status: 400,
    text: async () => 'Protocol not found',
  }));

  await assert.rejects(
    () => getProtocolTvl('not-a-real-protocol'),
    (err) => err instanceof ProtocolNotFoundError
  );
});

test('getProtocolTvl: caches repeat lookups for the same slug', async (t) => {
  resetDefiLlamaCache();
  let callCount = 0;
  mockFetch(t, async () => {
    callCount += 1;
    return { status: 200, text: async () => '100' };
  });

  await getProtocolTvl('uniswap');
  await getProtocolTvl('uniswap');
  assert.equal(callCount, 1);
});

test('getChainTvl: returns TVL for a matching chain name, case-insensitive', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({
    status: 200,
    json: async () => [
      { name: 'Ethereum', tvl: 41775106260.45556 },
      { name: 'Base', tvl: 4758348496.951872 },
    ],
  }));

  const tvl = await getChainTvl('ethereum');
  assert.equal(tvl, 41775106260.45556);
});

test('getChainTvl: unknown chain throws ChainNotFoundError', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({
    status: 200,
    json: async () => [{ name: 'Ethereum', tvl: 100 }],
  }));

  await assert.rejects(
    () => getChainTvl('not-a-real-chain'),
    (err) => err instanceof ChainNotFoundError
  );
});

test('getChainTvl: one /v2/chains call covers repeat lookups of different chains', async (t) => {
  resetDefiLlamaCache();
  let callCount = 0;
  mockFetch(t, async () => {
    callCount += 1;
    return {
      status: 200,
      json: async () => [
        { name: 'Ethereum', tvl: 100 },
        { name: 'Base', tvl: 200 },
      ],
    };
  });

  await getChainTvl('Ethereum');
  await getChainTvl('Base');
  assert.equal(callCount, 1);
});
