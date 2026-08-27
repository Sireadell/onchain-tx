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

test('tvl: missing both protocol and chain rejected before any call', async (t) => {
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const res = await fetch(`${base}/tvl`);
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('tvl: both protocol and tvl_chain return chain-specific and total protocol TVL', async (t) => {
  resetDefiLlamaCache();
  const calledPaths = [];
  mockFetch(t, async (url) => {
    calledPaths.push(url);
    if (url.includes('/protocol/')) {
      return { status: 200, json: async () => ({ currentChainTvls: { Ethereum: 4000 } }) };
    }
    return { status: 200, text: async () => '5000' };
  });
  const base = startServer(t);

  const res = await fetch(`${base}/tvl?protocol=aave-v3&tvl_chain=ethereum`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'protocol_chain');
  assert.equal(body.query, 'aave-v3:ethereum');
  assert.equal(body.tvl_usd, 4000);
  assert.equal(body.chain_tvl_usd, 4000);
  assert.equal(body.protocol_total_tvl_usd, 5000);
  assert.match(body.summary, /all chains/);
  assert.equal(calledPaths.length, 2);
});

test('tvl: successful protocol lookup returns tvl_usd and canonical', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({ status: 200, text: async () => '5000' }));
  const base = startServer(t);

  const res = await fetch(`${base}/tvl?protocol=uniswap`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'protocol');
  assert.equal(body.tvl_usd, 5000);
  assert.equal(body.canonical, 'protocol:uniswap:5000');
});

test('tvl: successful chain lookup returns tvl_usd', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({
    status: 200,
    json: async () => [{ name: 'Ethereum', tvl: 41775106260.45556 }],
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/tvl?tvl_chain=ethereum`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query_type, 'chain');
  assert.equal(body.tvl_usd, 41775106260.45556);
});

test('tvl: unknown protocol returns not_found, not an error', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async () => ({ status: 400, text: async () => 'Protocol not found' }));
  const base = startServer(t);

  const res = await fetch(`${base}/tvl?protocol=not-a-real-protocol`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.tvl_usd, null);
});
