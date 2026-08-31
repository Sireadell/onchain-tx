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
  assert.match(body.summary, /1234 holders/);
  assert.doesNotMatch(body.summary, /1,234 holders/);
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
