import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetBlockscoutCache } from '../lib/blockscoutApi.js';

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
    if (typeof url === 'string' && url.includes('.blockscout.com')) {
      return handler(url, ...rest);
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

const TOKEN = '0x' + 'a'.repeat(40);

test('token-holders: missing token param rejected before any call', async (t) => {
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const res = await fetch(`${base}/token-holders?chain=eth`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('token-holders: unsupported chain answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/token-holders?chain=solana&token=${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('token-holders: successful lookup returns holders_count and canonical', async (t) => {
  resetBlockscoutCache();
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({ holders_count: '1234', name: 'Test Token', symbol: 'TST' }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/token-holders?chain=eth&token=${TOKEN}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.holders_count, 1234);
  assert.equal(body.token_symbol, 'TST');
  assert.equal(body.canonical, `eth:${TOKEN}:1234`);
  // The holder count is the graded value, so it carries no separators.
  assert.match(body.summary, /\b1234 holders/);
  assert.doesNotMatch(body.summary, /\d,\d/);
});

test('token-holders: unknown token address returns not_found, not an error', async (t) => {
  resetBlockscoutCache();
  mockFetch(t, async () => ({ status: 404, statusText: 'Not Found', json: async () => ({}) }));
  const base = startServer(t);

  const res = await fetch(`${base}/token-holders?chain=eth&token=${TOKEN}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.holders_count, null);
});

test('token-holders: a Blockscout bot-check 403 falls back to the Ankr holder count', async (t) => {
  resetBlockscoutCache();
  process.env.ANKR_API_KEY = 'k';
  const original = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    const u = String(url);
    if (u.includes('.blockscout.com')) return new Response('Just a moment', { status: 403 });
    if (u.includes('rpc.ankr.com/multichain')) {
      return new Response(JSON.stringify({ result: { holderCountHistory: [{ holderCount: 4321 }] } }), { status: 200 });
    }
    return original(url, ...rest);
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);

  const res = await fetch(`${base}/token-holders?chain=base&token=${TOKEN}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.holders_count, 4321);
  assert.match(body.summary, /has 4321 holders/);
});

test('token-holders: reads the token name out of a question', async () => {
  const { tokenNameFromQuestion } = await import('./checkTokenHolders.js');
  assert.equal(tokenNameFromQuestion('How many holders does USDC on Ethereum have?'), 'USDC');
  assert.equal(tokenNameFromQuestion('Number of holders of the PEPE token'), 'PEPE');
  assert.equal(tokenNameFromQuestion('How many people hold Shiba Inu?'), 'Shiba Inu');
  assert.equal(tokenNameFromQuestion('What is the holder count of Ondo?'), 'Ondo');
});

test('token-holders: a well-known ticker resolves without a search', async (t) => {
  resetBlockscoutCache();
  const seen = [];
  mockFetch(t, async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ holders_count: 9606312, name: 'USD Coin', symbol: 'USDC', decimals: '6' }), { status: 200 });
  });
  const base = startServer(t);

  const res = await fetch(`${base}/token-holders?question=${encodeURIComponent('How many holders does USDC on Ethereum have?')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.holders_count, 9606312);
  assert.ok(seen.some((u) => u.includes('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')));
  assert.ok(!seen.some((u) => u.includes('/search')));
});

test('token-holders: an unlisted name is found by search, skipping unpriced copies', async (t) => {
  resetBlockscoutCache();
  const real = '0x' + 'b'.repeat(40);
  mockFetch(t, async (url) => {
    const u = String(url);
    if (u.includes('/search')) {
      return new Response(JSON.stringify({ items: [
        { type: 'token', token_type: 'ERC-20', name: 'Ondo', symbol: 'ONDO', address_hash: TOKEN, exchange_rate: null },
        { type: 'token', token_type: 'ERC-20', name: 'Ondo', symbol: 'ONDO', address_hash: real, exchange_rate: '0.8', circulating_market_cap: '2500000000' },
      ] }), { status: 200 });
    }
    if (u.includes(real)) return new Response(JSON.stringify({ holders_count: 223412, name: 'Ondo', symbol: 'ONDO' }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  const base = startServer(t);

  const res = await fetch(`${base}/token-holders?question=${encodeURIComponent('What is the holder count of Ondo?')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.holders_count, 223412);
});
