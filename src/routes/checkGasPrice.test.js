import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRpcCache } from '../lib/ankrRpc.js';
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
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      return handler(url, ...rest);
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

// Gas-price now also looks up the chain's native token price (coins.llama.fi)
// to compute a USD fee estimate. Mocked separately so these tests stay
// hermetic instead of hitting the real DefiLlama API.
function mockFetchWithPrice(t, ankrHandler, priceUsd = 2000) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      return ankrHandler(url, ...rest);
    }
    if (typeof url === 'string' && url.startsWith('https://coins.llama.fi/prices/current/')) {
      const key = decodeURIComponent(url.split('/prices/current/')[1]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ coins: { [key]: { price: priceUsd, symbol: 'ETH', timestamp: 1700000000 } } }),
      };
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
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.equal(body.error, undefined);
  assert.equal(called, false);
});

test('gas-price: successful read returns wei/gwei/fee_usd and canonical', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  resetDefiLlamaCache();
  mockFetchWithPrice(t, async (url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === 'eth_gasPrice' ? '0x3b9aca00' /* 1e9 wei = 1 gwei */ : '0x100';
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  }, 2000 /* mock ETH price */);
  const base = startServer(t);

  const res = await fetch(`${base}/gas-price?chain=eth`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.gas_price_wei, '1000000000');
  assert.equal(body.gas_price_gwei, 1);
  assert.equal(body.chain, 'eth');
  assert.equal(body.canonical, 'eth:gas_price:1000000000:256');
  assert.equal(body.native_price_usd, 2000);
  assert.equal(body.fee_usd, 1 * 1e-9 * 21_000 * 2000);
  assert.match(body.summary, /\$/);
  assert.ok(body.as_of);
});

test('gas-price: price lookup failure still returns gas price, fee_usd null', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  resetDefiLlamaCache();
  mockFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x3b9aca00' }) }));
  // No price mock registered — the real coins.llama.fi call 404s/network-errors here
  // since fetch falls through to whatever the environment does; instead, mock it to fail explicitly.
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url === 'string' && url.startsWith('https://rpc.ankr.com/')) {
      const { method } = JSON.parse(rest[0].body);
      const result = method === 'eth_gasPrice' ? '0x3b9aca00' : '0x100';
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
    }
    if (typeof url === 'string' && url.startsWith('https://coins.llama.fi/')) {
      return Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const base = startServer(t);

  const res = await fetch(`${base}/gas-price?chain=eth`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.gas_price_wei, '1000000000');
  assert.equal(body.fee_usd, null);
  assert.equal(body.native_price_usd, null);
  assert.doesNotMatch(body.summary, /\$/);
});

test('gas-price: omitted chain param falls back to default chain', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  resetDefiLlamaCache();
  mockFetchWithPrice(t, async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }));
  const base = startServer(t);

  const res = await fetch(`${base}/gas-price`);
  const body = await res.json();
  assert.equal(body.chain, 'eth');
});
