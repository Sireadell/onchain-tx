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

test('crypto-price: successful coin_id lookup returns price_usd and canonical', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({
      coins: { 'coingecko:bitcoin': { price: 64549.31, symbol: 'BTC', timestamp: 1787090150 } },
    }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=bitcoin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'coin_id');
  assert.equal(body.price_usd, 64549.31);
  assert.equal(body.symbol, 'BTC');
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
  mockFetch(t, async () => ({ status: 200, json: async () => ({ coins: {} }) }));
  const base = startServer(t);

  const res = await fetch(`${base}/crypto-price?coin_id=not-a-real-coin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.price_usd, null);
});
