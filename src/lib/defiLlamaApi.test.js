import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProtocolTvl,
  getProtocolChainTvl,
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

test('getProtocolChainTvl: returns protocol TVL for the requested chain only', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
    status: 200,
    json: async () => ({ currentChainTvls: { Ethereum: 150, 'Ethereum-borrowed': 90, Base: 25 } }),
  }));
  assert.equal(await getProtocolChainTvl('aave-v3', 'ethereum'), 150);
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

// Regression for a live bug verified against DefiLlama 2026-09-07: the chain
// list carries dead $0 stub entries literally named "Optimism" and "Binance"
// beside the real live entries "OP Mainnet" ($443M) and "BSC" ($5.79B), so
// asking for a chain by the name a person actually uses answered "$0.00 TVL"
// with full confidence.
test('getChainTvl: "Optimism" resolves to the live OP Mainnet entry, not the $0 stub', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
    status: 200,
    json: async () => [
      { name: 'Optimism', tvl: 0 },
      { name: 'OP Mainnet', tvl: 443501131.0151075 },
    ],
  }));

  assert.equal(await getChainTvl('Optimism'), 443501131.0151075);
  assert.equal(await getChainTvl('optimism'), 443501131.0151075);
});

test('getChainTvl: "Binance" resolves to the live BSC entry, not the $0 stub', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
    status: 200,
    json: async () => [
      { name: 'Binance', tvl: 0 },
      { name: 'BSC', tvl: 5792029314.2417145 },
    ],
  }));

  assert.equal(await getChainTvl('Binance'), 5792029314.2417145);
  assert.equal(await getChainTvl('binance smart chain'), 5792029314.2417145);
});

// Belt and braces for the same bug: a $0 stub appearing under a name that
// isn't aliased yet still must not beat a live entry of the same name.
test('getChainTvl: a live entry wins over a $0 entry of the same name', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
    status: 200,
    json: async () => [
      { name: 'Someswap', tvl: 0 },
      { name: 'Someswap', tvl: 12345.6 },
    ],
  }));

  assert.equal(await getChainTvl('someswap'), 12345.6);
});

// Regression: Hyperliquid is the 7th largest chain by TVL ($1.54B) and
// DefiLlama lists it only as "Hyperliquid L1", so it was unfindable under
// the name anyone would ask for.
test('getChainTvl: "Hyperliquid" resolves to the "Hyperliquid L1" entry', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
    status: 200,
    json: async () => [
      { name: 'Ethereum', tvl: 41775106260.45556 },
      { name: 'Hyperliquid L1', tvl: 1536786879.5289457 },
    ],
  }));

  assert.equal(await getChainTvl('Hyperliquid'), 1536786879.5289457);
});

// Fantom and Sonic are two genuinely separate live chains, not a rename, so
// neither may be aliased onto the other. Guards against a future "fix" that
// over-generalizes the Optimism/Binance aliases above.
test('getChainTvl: Fantom and Sonic stay separate chains', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
    status: 200,
    json: async () => [
      { name: 'Fantom', tvl: 4858978.121315509 },
      { name: 'Sonic', tvl: 16486809.816028453 },
    ],
  }));

  assert.equal(await getChainTvl('Fantom'), 4858978.121315509);
  assert.equal(await getChainTvl('Sonic'), 16486809.816028453);
});

// The chain-level aliases must not leak into a protocol's per-chain
// breakdown: DefiLlama keys those maps as "Optimism" and "Binance", so
// aliasing there would break lookups that currently work.
test('getProtocolChainTvl: still reads a protocol chain keyed "Optimism"', async (t) => {
  resetDefiLlamaCache();
  mockFetchHost(t, 'api.llama.fi', async () => ({
    status: 200,
    json: async () => ({
      currentChainTvls: { Optimism: 123456.78, 'Optimism-borrowed': 999, Ethereum: 5 },
    }),
  }));

  assert.equal(await getProtocolChainTvl('aave-v3', 'Optimism'), 123456.78);
});
