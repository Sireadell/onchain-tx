import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCoinPaprikaPrice, resetCoinPaprikaCache, CoinPaprikaNotFoundError } from './coinPaprikaApi.js';

const BTC_MATCHES = [
  { id: 'btc-bitcoin', name: 'Bitcoin', symbol: 'BTC', rank: 1, is_active: true },
  { id: 'bitcoin-bitcoin', name: 'bitcoin', symbol: 'BITCOIN', rank: 10622, is_active: true },
];
const ETH_MATCHES = [{ id: 'eth-ethereum', name: 'Ethereum', symbol: 'ETH', rank: 2, is_active: true }];
const DEAD_MATCHES = [{ id: 'dead-coin', name: 'Dead Coin', symbol: 'DEAD', rank: 3, is_active: false }];

const TICKER = {
  symbol: 'BTC',
  last_updated: '2026-08-29T02:01:24Z',
  quotes: { USD: { price: 77807.55, market_cap: 1562110242633, percent_change_24h: -2.68 } },
};

function mockFetch(t, { search = {}, onTicker } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/search/')) {
      const q = new URL(url).searchParams.get('q').toLowerCase();
      const currencies = search[q] ?? [];
      return { status: 200, json: async () => ({ currencies }) };
    }
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/tickers/')) {
      const id = url.split('/').pop();
      if (onTicker) return onTicker(id);
      return { status: 200, json: async () => TICKER };
    }
    return original(url);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('getCoinPaprikaPrice resolves by slug via search', async (t) => {
  resetCoinPaprikaCache();
  mockFetch(t, { search: { bitcoin: BTC_MATCHES } });
  const price = await getCoinPaprikaPrice('bitcoin');
  assert.equal(price.priceUsd, 77807.55);
  assert.equal(price.symbol, 'BTC');
  assert.equal(price.marketCapUsd, 1562110242633);
  assert.equal(price.change24hPct, -2.68);
});

test('getCoinPaprikaPrice resolves a slug collision to the lower-rank asset', async (t) => {
  resetCoinPaprikaCache();
  let requestedId;
  mockFetch(t, {
    search: { bitcoin: BTC_MATCHES },
    onTicker: async (id) => {
      requestedId = id;
      return { status: 200, json: async () => TICKER };
    },
  });
  await getCoinPaprikaPrice('bitcoin');
  assert.equal(requestedId, 'btc-bitcoin');
});

test('getCoinPaprikaPrice resolves by ticker symbol via search', async (t) => {
  resetCoinPaprikaCache();
  let requestedId;
  mockFetch(t, {
    search: { btc: BTC_MATCHES },
    onTicker: async (id) => {
      requestedId = id;
      return { status: 200, json: async () => TICKER };
    },
  });
  const price = await getCoinPaprikaPrice('BTC');
  assert.equal(requestedId, 'btc-bitcoin');
  assert.equal(price.priceUsd, 77807.55);
});

test('getCoinPaprikaPrice ignores a fuzzy non-exact search hit', async (t) => {
  resetCoinPaprikaCache();
  // "bitcoin cash" is a real, unrelated asset that a fuzzy search for
  // "bitcoin" might surface — it must not be accepted as a match for the
  // exact slug "bitcoin".
  mockFetch(t, {
    search: { bitcoin: [{ id: 'bch-bitcoin-cash', name: 'Bitcoin Cash', symbol: 'BCH', rank: 15, is_active: true }] },
  });
  await assert.rejects(getCoinPaprikaPrice('bitcoin'), CoinPaprikaNotFoundError);
});

test('getCoinPaprikaPrice resolves a coin name embedded in a whole question', async (t) => {
  resetCoinPaprikaCache();
  let requestedId;
  mockFetch(t, {
    search: { bitcoin: BTC_MATCHES },
    onTicker: async (id) => {
      requestedId = id;
      return { status: 200, json: async () => TICKER };
    },
  });
  await getCoinPaprikaPrice('What is bitcoin worth right now?');
  assert.equal(requestedId, 'btc-bitcoin');
});

test('getCoinPaprikaPrice resolves a ticker embedded in a whole question', async (t) => {
  resetCoinPaprikaCache();
  let requestedId;
  mockFetch(t, {
    search: { eth: ETH_MATCHES },
    onTicker: async (id) => {
      requestedId = id;
      return { status: 200, json: async () => TICKER };
    },
  });
  await getCoinPaprikaPrice('price of ETH in USD');
  assert.equal(requestedId, 'eth-ethereum');
});

test('getCoinPaprikaPrice caches a resolution so a repeat lookup does not search again', async (t) => {
  resetCoinPaprikaCache();
  let searchCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/search/')) {
      searchCalls += 1;
      return { status: 200, json: async () => ({ currencies: BTC_MATCHES }) };
    }
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/tickers/')) {
      return { status: 200, json: async () => TICKER };
    }
    return original(url);
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  await getCoinPaprikaPrice('bitcoin');
  // A different-cased input maps to the same resolution cache key
  // ("bitcoin") but a different price cache key — proving it's the
  // resolution cache, not the price cache, avoiding the second search.
  await getCoinPaprikaPrice('BITCOIN');
  assert.equal(searchCalls, 1);
});

test('getCoinPaprikaPrice ignores inactive coins', async (t) => {
  resetCoinPaprikaCache();
  mockFetch(t, { search: { dead: DEAD_MATCHES } });
  await assert.rejects(getCoinPaprikaPrice('dead'), CoinPaprikaNotFoundError);
});

test('getCoinPaprikaPrice throws CoinPaprikaNotFoundError for an unresolvable id', async (t) => {
  resetCoinPaprikaCache();
  mockFetch(t, { search: {} });
  await assert.rejects(getCoinPaprikaPrice('not-a-real-coin-xyz'), CoinPaprikaNotFoundError);
});
