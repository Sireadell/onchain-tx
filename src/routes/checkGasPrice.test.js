import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRpcCache } from '../lib/ankrRpc.js';

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
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      return handler(url, ...rest);
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('gas-price: unsupported chain rejected before any RPC call', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const res = await fetch(`${base}/gas-price?chain=solana`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.status, 'error');
  assert.equal(called, false);
});

test('gas-price: successful read returns wei/gwei and canonical', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === 'eth_gasPrice' ? '0x3b9aca00' /* 1e9 wei = 1 gwei */ : '0x100';
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  });
  const base = startServer(t);

  const res = await fetch(`${base}/gas-price?chain=eth`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.gas_price_wei, '1000000000');
  assert.equal(body.gas_price_gwei, 1);
  assert.equal(body.chain, 'eth');
  assert.equal(body.canonical, 'eth:gas_price:1000000000:256');
  assert.ok(body.as_of);
});

test('gas-price: omitted chain param falls back to default chain', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }));
  const base = startServer(t);

  const res = await fetch(`${base}/gas-price`);
  const body = await res.json();
  assert.equal(body.chain, 'eth');
});
