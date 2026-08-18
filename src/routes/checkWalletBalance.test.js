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

const ADDRESS = '0x' + 'a'.repeat(40);

test('wallet-balance: missing address is rejected before any RPC call', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const res = await fetch(`${base}/wallet-balance?chain=eth`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.status, 'error');
  assert.equal(called, false);
});

test('wallet-balance: malformed address is rejected', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?address=not-an-address`);
  assert.equal(res.status, 400);
});

test('wallet-balance: unsupported chain rejected', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?chain=solana&address=${ADDRESS}`);
  assert.equal(res.status, 400);
});

test('wallet-balance: successful read returns wei/native and canonical', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === 'eth_getBalance' ? '0xde0b6b3a7640000' /* 1e18 wei = 1 ether */ : '0x100';
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  });
  const base = startServer(t);

  const res = await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.balance_wei, '1000000000000000000');
  assert.equal(body.balance_native, 1);
  assert.equal(body.address, ADDRESS);
  assert.equal(body.canonical, `eth:${ADDRESS}:1000000000000000000`);
});
