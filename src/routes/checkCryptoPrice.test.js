import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetDefiLlamaCache } from '../lib/defiLlamaApi.js';

function startServer(t) {
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

// coin_id mode tries CoinGecko first now (see checkCryptoPrice.js header
// comment) — mocks both hosts so tests stay hermetic instead of hitting
// the real CoinGecko API.
function mockFetchWithCoinGecko(t, { coingecko, defillama } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
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
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('crypto-price: coin_id and price_chain/token both supplied rejected', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin&price_chain=ethereum&token=${TOKEN}`);
  assert.equal(res.status, 400);
});

test('crypto-price: price_chain without token rejected', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?price_chain=ethereum`);
  assert.equal(res.status, 400);
});

test('crypto-price: malformed token address rejected', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/crypto-price?price_chain=ethereum&token=not-an-address`);
  assert.equal(res.status, 400);
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
