import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetDefiLlamaCache } from '../lib/defiLlamaApi.js';
import { resetCoinGeckoCache } from '../lib/coinGeckoApi.js';
import { resetCoinPaprikaCache } from '../lib/coinPaprikaApi.js';

function startServer(t) {
  resetCoinGeckoCache();
  resetCoinPaprikaCache();
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// /crypto-price's chain_token mode only ever calls coins.llama.fi (prices
// live on a different DefiLlama host than TVL) — asserting the exact host
// here would have caught the 2026-08-18 host-mismatch bug (code was
// hardcoded to api.llama.fi, which 404s for /prices/current/*) without
// needing a live deploy to surface it.
function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url !== 'string' || !url.includes('llama.fi')) {
      return original(url, ...rest);
    }
    if (!url.startsWith('https://coins.llama.fi/')) {
      throw new Error(`expected /crypto-price to call coins.llama.fi, got ${url}`);
    }
    return handler(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

// coin_id mode races CoinPaprika, CoinGecko, and DefiLlama (see
// checkCryptoPrice.js header comment) — mocks all three hosts so tests
// stay hermetic instead of hitting real APIs. A test that doesn't pass a
// `coinpaprika` handler gets the "no exact match" shape by default (empty
// search results -> no resolution), since CoinPaprika is now the
// preferred source and most existing tests are specifically about the
// other two. `coinpaprika` mocks the resolution call
// (/v1/search/?q=...&c=currencies) CoinPaprika's client makes to turn a
// coin_id into a real asset id — see coinPaprikaApi.js's searchExactAsset.
function mockFetchWithCoinGecko(t, { coinpaprika, coinpaprikaTicker, coingecko, defillama } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/search/')) {
      if (coinpaprika) return coinpaprika(url, ...rest);
      return { status: 200, json: async () => ({ currencies: [] }) };
    }
    if (typeof url === 'string' && url.startsWith('https://api.coinpaprika.com/v1/tickers/')) {
      if (!coinpaprikaTicker) throw new Error(`unexpected CoinPaprika ticker call in this test: ${url}`);
      return coinpaprikaTicker(url, ...rest);
    }
    if (typeof url === 'string' && url.startsWith('https://api.coingecko.com/')) {
      if (!coingecko) throw new Error('unexpected CoinGecko call in this test');
      return coingecko(url, ...rest);
    }
    if (typeof url === 'string' && url.startsWith('https://coins.llama.fi/')) {
      if (!defillama) throw new Error('unexpected DefiLlama call in this test');
      return defillama(url, ...rest);
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

const TOKEN = '0x' + 'a'.repeat(40);

test('crypto-price: missing all params rejected before any call', async (t) => {
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('crypto-price: coin_id and price_chain/token both supplied answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin&price_chain=ethereum&token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('crypto-price: price_chain without token answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?price_chain=ethereum`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('crypto-price: malformed token address answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?price_chain=ethereum&token=not-an-address`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('crypto-price: successful coin_id lookup prefers CoinPaprika over CoinGecko', async (t) => {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => ({
      status: 200,
      json: async () => ({
        currencies: [
          { id: 'btc-bitcoin', symbol: 'BTC', is_active: true, rank: 1 },
          { id: 'bitcoin-bitcoin', symbol: 'BITCOIN', is_active: true, rank: 10622 },
        ],
      }),
    }),
    coinpaprikaTicker: async (url) => {
      assert.equal(url, 'https://api.coinpaprika.com/v1/tickers/btc-bitcoin');
      return {
        status: 200,
        json: async () => ({
          symbol: 'BTC',
          last_updated: '2026-08-29T02:01:24Z',
          quotes: { USD: { price: 77807.55, market_cap: 1562110242633, percent_change_24h: -2.68 } },
        }),
      };
    },
    coingecko: async () => {
      throw new Error('CoinGecko should not be needed when CoinPaprika succeeds');
    },
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.price_usd, 77807.55);
  assert.equal(body.symbol, 'BTC');
  assert.equal(body.price_source, 'coinpaprika');
  assert.equal(body.change_24h_pct, -2.68);
  assert.equal(body.market_cap_usd, 1562110242633);
});

test('crypto-price: multi-source summary names the sources that actually answered', async (t) => {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => ({
      status: 200,
      json: async () => ({ currencies: [{ id: 'btc-bitcoin', symbol: 'BTC', is_active: true, rank: 1 }] }),
    }),
    coinpaprikaTicker: async () => ({
      status: 200,
      json: async () => ({
        symbol: 'BTC',
        last_updated: '2026-08-29T02:01:24Z',
        quotes: { USD: { price: 77801.51, market_cap: 1561989416378, percent_change_24h: -2.7 } },
      }),
    }),
    coingecko: async () => ({ status: 500, statusText: 'Internal Server Error' }),
    defillama: async () => ({
      status: 200,
      json: async () => ({ coins: { 'coingecko:bitcoin': { price: 77776.27, symbol: 'BTC', timestamp: 1787090000 } } }),
    }),
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  const body = await res.json();
  assert.equal(body.price_source, 'coinpaprika');
  assert.match(body.summary, /CoinPaprika and DefiLlama currently report a range/);
  assert.doesNotMatch(body.summary, /CoinGecko/);
});

test('crypto-price: CoinPaprika slug collision resolves to the lower-rank (dominant) asset', async (t) => {
  resetDefiLlamaCache();
  let requestedId = null;
  mockFetchWithCoinGecko(t, {
    coinpaprika: async () => ({
      status: 200,
      json: async () => ({
        currencies: [
          { id: 'bitcoin-bitcoin', symbol: 'BITCOIN', is_active: true, rank: 10622 },
          { id: 'btc-bitcoin', symbol: 'BTC', is_active: true, rank: 1 },
        ],
      }),
    }),
    coinpaprikaTicker: async (url) => {
      requestedId = url;
      return {
        status: 200,
        json: async () => ({
          symbol: 'BTC',
          last_updated: '2026-08-29T02:01:24Z',
          quotes: { USD: { price: 77807.55, market_cap: 1562110242633, percent_change_24h: -2.68 } },
        }),
      };
    },
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  assert.equal(res.status, 200);
  assert.equal(requestedId, 'https://api.coinpaprika.com/v1/tickers/btc-bitcoin');
});

test('crypto-price: successful coin_id lookup uses CoinGecko directly', async (t) => {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    coingecko: async () => ({
      status: 200,
      json: async () => ({ bitcoin: { usd: 64549.31, usd_market_cap: 1270000000000, usd_24h_change: 3.25, last_updated_at: 1787090150 } }),
    }),
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'coin_id');
  assert.equal(body.price_usd, 64549.31);
  assert.equal(body.symbol, 'bitcoin');
  assert.equal(body.price_source, 'coingecko');
  assert.equal(body.change_24h_pct, 3.25);
  assert.equal(body.market_cap_usd, 1270000000000);
  assert.match(body.summary, /up 3.25%/);
});

test('crypto-price: CoinGecko failure falls back to DefiLlama', async (t) => {
  resetDefiLlamaCache();
  mockFetchWithCoinGecko(t, {
    coingecko: async () => ({ status: 500, statusText: 'Internal Server Error' }),
    defillama: async () => ({
      status: 200,
      json: async () => ({
        coins: { 'coingecko:bitcoin': { price: 64100, symbol: 'BTC', timestamp: 1787090000 } },
      }),
    }),
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.price_usd, 64100);
  assert.equal(body.symbol, 'BTC');
  assert.equal(body.price_source, 'defillama');
});

test('crypto-price: successful chain_token lookup', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({
      coins: { [`ethereum:${TOKEN}`]: { price: 1.0, symbol: 'USDC', timestamp: 1787090150 } },
    }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?price_chain=ethereum&token=${TOKEN}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'chain_token');
  assert.equal(body.price_usd, 1.0);
});

test('crypto-price: unknown coin returns not_found, not an error', async (t) => {
  resetDefiLlamaCache();
  // Neither CoinGecko nor the DefiLlama fallback recognize the id.
  mockFetchWithCoinGecko(t, {
    coingecko: async () => ({ status: 200, json: async () => ({}) }),
    defillama: async () => ({ status: 200, json: async () => ({ coins: {} }) }),
  });
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=not-a-real-coin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.price_usd, null);
});
