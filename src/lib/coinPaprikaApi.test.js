import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCoinPaprikaPrice, resetCoinPaprikaCache, CoinPaprikaNotFoundError } from './coinPaprikaApi.js';

const COIN_LIST = [
  { id: 'btc-bitcoin', name: 'Bitcoin', symbol: 'BTC', rank: 1, is_active: true },
  { id: 'bitcoin-bitcoin', name: 'bitcoin', symbol: 'BITCOIN', rank: 10622, is_active: true },
  { id: 'eth-ethereum', name: 'Ethereum', symbol: 'ETH', rank: 2, is_active: true },
  { id: 'dead-coin', name: 'Dead Coin', symbol: 'DEAD', rank: 3, is_active: false },
];

const TICKER = {
  symbol: 'BTC',
  last_updated: '2026-08-29T02:01:24Z',
  quotes: { USD: { price: 77807.55, market_cap: 1562110242633, percent_change_24h: -2.68 } },
};

function mockFetch(t, { onTicker } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/coins')) {
      return { status: 200, json: async () => COIN_LIST };
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

test('getCoinPaprikaPrice resolves by slug', async (t) => {
  resetCoinPaprikaCache();
  mockFetch(t);
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
    onTicker: async (id) => {
      requestedId = id;
      return { status: 200, json: async () => TICKER };
    },
  });
  await getCoinPaprikaPrice('bitcoin');
  assert.equal(requestedId, 'btc-bitcoin');
});

test('getCoinPaprikaPrice resolves by ticker symbol', async (t) => {
  resetCoinPaprikaCache();
  let requestedId;
  mockFetch(t, {
    onTicker: async (id) => {
      requestedId = id;
      return { status: 200, json: async () => TICKER };
    },
  });
  const price = await getCoinPaprikaPrice('BTC');
  assert.equal(requestedId, 'btc-bitcoin');
  assert.equal(price.priceUsd, 77807.55);
});

test('getCoinPaprikaPrice resolves a coin name embedded in a whole question', async (t) => {
  resetCoinPaprikaCache();
  let requestedId;
  mockFetch(t, {
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
    onTicker: async (id) => {
      requestedId = id;
      return { status: 200, json: async () => TICKER };
    },
  });
  await getCoinPaprikaPrice('price of ETH in USD');
  assert.equal(requestedId, 'eth-ethereum');
});

test('getCoinPaprikaPrice ignores inactive coins', async (t) => {
  resetCoinPaprikaCache();
  mockFetch(t);
  await assert.rejects(getCoinPaprikaPrice('dead'), CoinPaprikaNotFoundError);
});

test('getCoinPaprikaPrice throws CoinPaprikaNotFoundError for an unresolvable id', async (t) => {
  resetCoinPaprikaCache();
  mockFetch(t);
  await assert.rejects(getCoinPaprikaPrice('not-a-real-coin-xyz'), CoinPaprikaNotFoundError);
});
