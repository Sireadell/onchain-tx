import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProtocolTvl,
  getChainTvl,
  getCoinPrice,
  resetDefiLlamaCache,
  ProtocolNotFoundError,
  ChainNotFoundError,
  CoinNotFoundError,
} from './defiLlamaApi.js';

// Stricter than a loose URL-substring matcher — asserts the exact host, so a function
// silently calling the wrong DefiLlama host (api.llama.fi vs
// coins.llama.fi are different products) fails the test loudly instead of
// the mock quietly intercepting whatever URL shows up. Caught a real bug
// this way 2026-08-18: getCoinPrice was hardcoded to api.llama.fi (copied
// from getProtocolTvl/getChainTvl) when prices actually live on
// coins.llama.fi — passed every test under the old loose matcher because
// it matched both hosts, only surfaced testing the real deployment.
function mockFetchHost(t, expectedHost, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url !== 'string' || !url.includes('llama.fi')) {
      return original(url, ...rest);
    }
    if (!url.startsWith(`https://${expectedHost}/`)) {
      throw new Error(`expected DefiLlama call to https://${expectedHost}/..., got ${url}`);
    }
    return handler(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('getProtocolTvl: returns numeric TVL on success', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
    status: 200,
    text: async () => '2948648103.30746',
  }));

  const tvl = await getProtocolTvl('uniswap');
  assert.equal(tvl, 2948648103.30746);
});

test('getProtocolTvl: unknown protocol throws ProtocolNotFoundError', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
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
  mockFetchHost(t, 'api.llama.fi', async () => {
    callCount += 1;
    return { status: 200, text: async () => '100' };
  });

  await getProtocolTvl('uniswap');
  await getProtocolTvl('uniswap');
  assert.equal(callCount, 1);
});

test('getChainTvl: returns TVL for a matching chain name, case-insensitive', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
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
  mockFetchHost(t, 'api.llama.fi', async () => ({
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
  mockFetchHost(t, 'api.llama.fi', async () => {
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

test('getCoinPrice: returns price/symbol for a known coin key', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'coins.llama.fi', async () => ({
    status: 200,
    json: async () => ({
      coins: { 'coingecko:bitcoin': { price: 64549.31, symbol: 'BTC', timestamp: 1787090150 } },
    }),
  }));

  const info = await getCoinPrice('coingecko:bitcoin');
  assert.equal(info.priceUsd, 64549.31);
  assert.equal(info.symbol, 'BTC');
});

test('getCoinPrice: key absent from response coins throws CoinNotFoundError', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'coins.llama.fi', async () => ({ status: 200, json: async () => ({ coins: {} }) }));

  await assert.rejects(
    () => getCoinPrice('coingecko:not-a-real-coin'),
    (err) => err instanceof CoinNotFoundError
  );
});

test('getCoinPrice: caches repeat lookups for the same key', async (t) => {
  resetDefiLlamaCache();
  let callCount = 0;
  mockFetchHost(t, 'coins.llama.fi', async () => {
    callCount += 1;
    return { status: 200, json: async () => ({ coins: { 'coingecko:bitcoin': { price: 100, symbol: 'BTC', timestamp: 1 } } }) };
  });

  await getCoinPrice('coingecko:bitcoin');
  await getCoinPrice('coingecko:bitcoin');
  assert.equal(callCount, 1);
});
