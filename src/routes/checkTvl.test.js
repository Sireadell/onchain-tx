import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetDefiLlamaCache } from '../lib/defiLlamaApi.js';
import { extractTvlProtocol } from './checkTvl.js';

test('tvl: extracts protocols from the three hard questions', () => {
  assert.equal(extractTvlProtocol("What is Uniswap's aggregate live TVL across every chain, in USD?"), 'Uniswap');
  assert.equal(extractTvlProtocol("Report Aave's present total value locked, not market capitalization or borrowed value."), 'Aave');
  assert.equal(extractTvlProtocol('How much capital is currently locked in Curve DEX across its deployments?'), 'Curve');
});

test('tvl: possessive and locked-in extraction handles contractions, versions, articles, and multiword names', () => {
  assert.equal(extractTvlProtocol("What's Uniswap's current TVL?"), 'Uniswap');
  assert.equal(extractTvlProtocol("What is Aave V3's current TVL?"), 'Aave V3');
  assert.equal(extractTvlProtocol('How much capital is locked in the Rocket Pool protocol?'), 'Rocket Pool');
  assert.equal(extractTvlProtocol('How much is locked in the Aave protocol?'), 'Aave');
});

test('tvl: possessive extraction refuses ambiguous or non-governing names', () => {
  assert.equal(extractTvlProtocol("What is Ethereum's share of Aave's TVL?"), null);
  assert.equal(extractTvlProtocol("Compare Uniswap's TVL with Aave's TVL"), null);
  assert.equal(extractTvlProtocol("What is Aave's market capitalization compared with TVL?"), null);
});

test('tvl: non-possessive multi-protocol questions are refused without malformed extraction', () => {
  assert.equal(extractTvlProtocol('Compare the TVL of Uniswap and Aave'), null);
  assert.equal(extractTvlProtocol('How much is locked in Uniswap and Aave?'), null);
});

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
  assert.match(body.summary, /on ethereum has \$4000\.00 TVL/);
  assert.doesNotMatch(body.summary, /5000/);
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

test('tvl: "the Aave protocol on the Polygon network" is read as aave on Polygon', async (t) => {
  resetDefiLlamaCache();
  mockFetch(t, async (url) => {
    if (url.includes('/protocol/')) {
      return { status: 200, json: async () => ({ name: 'Aave', category: 'Lending', currentChainTvls: { Polygon: 134, Ethereum: 4000 }, chainTvls: { Polygon: { tvl: [{ date: 1000000, totalLiquidityUSD: 100 }, { date: 1000000 + 7 * 86400, totalLiquidityUSD: 120 }, { date: 1000000 + 8 * 86400, totalLiquidityUSD: 134 }] } } }) };
    }
    return { status: 200, text: async () => '5000' };
  });
  const base = startServer(t);
  const res = await fetch(`${base}/tvl?query=${encodeURIComponent('What is the current Total Value Locked (TVL) for the Aave protocol on the Polygon network?')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.query, 'Aave:Polygon');
  assert.equal(body.tvl_usd, 134);
  assert.match(body.summary, /^Aave on Polygon has \$134\.00 TVL/);
  assert.match(body.summary, /up 11\.67% over the last day/);
  assert.match(body.summary, /Its DefiLlama category is Lending/);
});

test('tvl: "all of DeFi" answers the market total and "the Solana blockchain" answers the chain', async (t) => {
  resetDefiLlamaCache();
  const day = 86400;
  mockFetch(t, async (url) => {
    if (url.includes('/v2/historicalChainTvl')) {
      const pts = [];
      for (let i = 0; i < 10; i += 1) pts.push({ date: 2_000_000 + i * day, tvl: 1000 + i * 10 });
      return { status: 200, json: async () => pts };
    }
    if (url.includes('/v2/chains')) return { status: 200, json: async () => [{ name: 'Solana', tvl: 5000 }] };
    return { status: 404, text: async () => 'not found' };
  });
  const base = startServer(t);
  const defi = await (await fetch(`${base}/tvl?query=${encodeURIComponent('What is the total value locked across all of DeFi?')}`)).json();
  assert.equal(defi.status, 'ok');
  assert.equal(defi.query_type, 'defi_total');
  assert.equal(defi.tvl_usd, 1090);
  assert.match(defi.summary, /^DeFi has \$1090\.00 total value locked across all chains/);
  const chain = await (await fetch(`${base}/tvl?query=${encodeURIComponent('What is the TVL of the Solana blockchain?')}`)).json();
  assert.equal(chain.query_type, 'chain');
  assert.equal(chain.tvl_usd, 5000);
});
