import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRpcCache } from '../lib/ankrRpc.js';
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
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.equal(body.error, undefined);
  assert.equal(called, false);
});

test('wallet-balance: malformed address is answered with guidance', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?address=not-an-address`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('wallet-balance: unsupported chain answered with guidance', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?chain=solana&address=${ADDRESS}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
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

const TOKEN = '0x' + 'b'.repeat(40);

test('wallet-balance: malformed token param is answered with guidance', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?address=${ADDRESS}&token=not-an-address`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('wallet-balance: token param returns normalized ERC-20 balance', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  resetBlockscoutCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      // 1000 USDC raw (6 decimals) = 1000000000
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }) });
    }
    if (typeof url === 'string' && url.includes('.blockscout.com')) {
      return Promise.resolve({ status: 200, json: async () => ({ decimals: '6', symbol: 'USDC', name: 'USD Coin' }) });
    }
    return originalFetch(url, options);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const base = startServer(t);

  const res = await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}&token=${TOKEN}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.balance_wei, '1000000000');
  assert.equal(body.balance_native, 1000);
  assert.equal(body.token_symbol, 'USDC');
  assert.equal(body.token_decimals, 6);
  assert.equal(body.canonical, `eth:${ADDRESS}:${TOKEN}:1000000000`);
});

test('wallet-balance: token not recognized by Blockscout still returns raw balance', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  resetBlockscoutCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x64' }) });
    }
    if (typeof url === 'string' && url.includes('.blockscout.com')) {
      return Promise.resolve({ status: 404, statusText: 'Not Found', json: async () => ({}) });
    }
    return originalFetch(url, options);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const base = startServer(t);

  const res = await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}&token=${TOKEN}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.balance_wei, '100');
  assert.equal(body.balance_native, null);
  assert.equal(body.token_symbol, null);
});
