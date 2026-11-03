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
