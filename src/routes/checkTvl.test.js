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
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
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

test('tvl: explicit chain is honored and refuses a protocol absent from that chain', async (t) => {
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

  const res = await fetch(`${base}/tvl?protocol=aave-v3&chain=solana`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'not_found');
  assert.equal(body.query_type, 'protocol_chain');
  assert.equal(body.query, 'aave-v3:solana');
  assert.equal(body.tvl_usd, null);
  assert.match(body.summary, /no DefiLlama protocol_chain found/);
  assert.ok(calledPaths.some((url) => url.includes('/protocol/aave-v3')));
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

// Regression: measured against the live network on 2026-09-02, every
// natural-language TVL question failed because the engine passes the whole
// question as `protocol` and this route looked up a protocol by that entire
// sentence. Prose in the parameter must be reduced to the protocol it names.
test('tvl: a whole question sent as the protocol parameter resolves to the protocol', async (t) => {
  resetDefiLlamaCache();
  const requested = [];
  mockFetch(t, async (url) => {
    requested.push(url);
    return { status: 200, text: async () => '3467427625.51' };
  });
  const base = startServer(t);

  const res = await fetch(`${base}/tvl?protocol=${encodeURIComponent('How much value is locked in Uniswap?')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.ok(
    requested.some((u) => u.toLowerCase().includes('uniswap')),
    `expected a lookup for uniswap, got ${requested.join(', ')}`,
  );
  assert.ok(!requested.some((u) => u.includes('How%20much')), 'the raw sentence must not be sent as a protocol name');
});

test('tvl: "locked in" phrasing does not leak into the protocol name', async (t) => {
  resetDefiLlamaCache();
  const requested = [];
  mockFetch(t, async (url) => {
    requested.push(url);
    return { status: 200, text: async () => '1000' };
  });
  const base = startServer(t);

  await fetch(`${base}/tvl?protocol=${encodeURIComponent('How much money is locked in Curve right now?')}`);
  assert.ok(
    requested.some((u) => u.toLowerCase().includes('curve')),
    `expected a lookup for curve, got ${requested.join(', ')}`,
  );
  assert.ok(!requested.some((u) => u.toLowerCase().includes('locked')), '"locked" must be stripped from the name');
});

test('tvl: a bare protocol slug is still passed through untouched', async (t) => {
  resetDefiLlamaCache();
  const requested = [];
  mockFetch(t, async (url) => {
    requested.push(url);
    return { status: 200, text: async () => '5000' };
  });
  const base = startServer(t);

  const res = await fetch(`${base}/tvl?protocol=aave-v3`);
  assert.equal((await res.json()).status, 'ok');
  assert.ok(requested.some((u) => u.includes('aave-v3')), 'the slug must be used as given');
});
