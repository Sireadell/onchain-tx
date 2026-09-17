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

function withKey(t, value = 'ankr-test-key') {
  const previous = process.env.ANKR_API_KEY;
  if (value) process.env.ANKR_API_KEY = value;
  else delete process.env.ANKR_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.ANKR_API_KEY;
    else process.env.ANKR_API_KEY = previous;
  });
}

// Stubs rpc.ankr.com/{segment}/{key} JSON-RPC calls. `perChain` maps a chain
// segment to a handler `(method, params) => resultOrThrow`, so each test can
// give some chains a real answer and others a failure without a real network.
function stubAnkr(t, perChain) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (!str.startsWith('https://rpc.ankr.com/')) return original(url, init);
    const segment = str.split('/')[3];
    const { method, params } = JSON.parse(init.body);
    calls.push({ segment, method, params });
    const handler = perChain[segment];
    if (!handler) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: `no handler for ${segment}` } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    try {
      const result = await handler(method, params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: err.message } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const ADDRESS = '0x' + 'a'.repeat(40);

// Every chain has a live balance and contract-code answer, all active.
function activeHandler(method) {
  if (method === 'eth_getBalance') return '0xde0b6b3a7640000'; // 1 ether
  if (method === 'eth_getCode') return '0x600160005401';
  throw new Error(`unexpected method ${method}`);
}

// Every chain answers, but is empty (no balance, no code).
function emptyHandler(method) {
  if (method === 'eth_getBalance') return '0x0';
  if (method === 'eth_getCode') return '0x';
  throw new Error(`unexpected method ${method}`);
}

test('cross-chain-state: missing address answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/cross-chain-state`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('cross-chain-state: reports active status per chain and an aggregate summary', async (t) => {
  withKey(t);
  resetRpcCache();
  stubAnkr(t, { eth: activeHandler, base: activeHandler, arbitrum: activeHandler, polygon: activeHandler, avalanche: activeHandler });
  const server = startServer(t);
  const res = await fetch(`${server}/cross-chain-state?address=${ADDRESS}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.chains_checked.length, 5);
  assert.equal(body.results.length, 5);
  for (const r of body.results) {
    assert.equal(r.reachable, true);
    assert.equal(r.active, true);
    assert.equal(r.is_contract, true);
    assert.equal(r.balance_native, '1');
  }
  assert.match(body.summary, /is active on/);
  assert.equal(body.confidence, 1.0);
});

test('cross-chain-state: the chains param restricts which chains are queried', async (t) => {
  withKey(t);
  resetRpcCache();
  const calls = stubAnkr(t, { eth: activeHandler, base: activeHandler });
  const server = startServer(t);
  const res = await fetch(`${server}/cross-chain-state?address=${ADDRESS}&chains=eth,base`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.chains_checked.sort(), ['base', 'eth']);
  const segmentsHit = new Set(calls.map((c) => c.segment));
  assert.deepEqual([...segmentsHit].sort(), ['base', 'eth']);
});

test('cross-chain-state: one chain failing to answer does not crash the aggregate response', async (t) => {
  withKey(t);
  resetRpcCache();
  stubAnkr(t, {
    eth: activeHandler,
    base: () => { throw new Error('upstream unavailable'); },
  });
  const server = startServer(t);
  const res = await fetch(`${server}/cross-chain-state?address=${ADDRESS}&chains=eth,base`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  const eth = body.results.find((r) => r.chain === 'eth');
  const base = body.results.find((r) => r.chain === 'base');
  assert.equal(eth.reachable, true);
  assert.equal(eth.active, true);
  assert.equal(base.reachable, false);
  assert.equal(base.active, null);
  assert.ok(base.error, 'failed chain should carry an error message');
  assert.equal(body.confidence, 0.7);
});

test('cross-chain-state: an address with no balance or code anywhere is reported inactive', async (t) => {
  withKey(t);
  resetRpcCache();
  stubAnkr(t, { eth: emptyHandler, base: emptyHandler, arbitrum: emptyHandler, polygon: emptyHandler, avalanche: emptyHandler });
  const server = startServer(t);
  const res = await fetch(`${server}/cross-chain-state?address=${ADDRESS}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /appears inactive/);
});

test('cross-chain-state: chains named in the question restrict the check, unsupported ones are named honestly', async (t) => {
  withKey(t);
  resetRpcCache();
  const calls = stubAnkr(t, { base: activeHandler, arbitrum: emptyHandler });
  const server = startServer(t);
  const q = `Does the wallet ${ADDRESS} exist on Base and Arbitrum, and on Solana?`;
  const res = await fetch(`${server}/cross-chain-state?question=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.chains_checked.sort(), ['arbitrum', 'base']);
  assert.deepEqual([...new Set(calls.map((c) => c.segment))].sort(), ['arbitrum', 'base']);
  assert.deepEqual(body.chains_unsupported, ['solana']);
  assert.match(body.summary, /is active on Base \(contract, 1 ETH\)/);
  assert.match(body.summary, /No balance or code on Arbitrum/);
  assert.match(body.summary, /Solana is not checked by this miner/);
});

test('cross-chain-state: "ETH balance on Base" names Base only, not Ethereum', async (t) => {
  withKey(t);
  resetRpcCache();
  const calls = stubAnkr(t, { base: activeHandler });
  const server = startServer(t);
  await fetch(`${server}/cross-chain-state?question=${encodeURIComponent(`What is the ETH balance of ${ADDRESS} on Base?`)}`);
  assert.deepEqual([...new Set(calls.map((c) => c.segment))], ['base']);
});

test('cross-chain-state: chains=solana,bitcoin falls back to every supported chain and says so', async (t) => {
  withKey(t);
  resetRpcCache();
  stubAnkr(t, { eth: emptyHandler, base: emptyHandler, arbitrum: emptyHandler, polygon: emptyHandler, avalanche: emptyHandler });
  const server = startServer(t);
  const res = await fetch(`${server}/cross-chain-state?address=${ADDRESS}&chains=solana,bitcoin`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.chains_checked.length, 5);
  assert.match(body.summary, /Solana, Bitcoin are not checked by this miner/);
});

test('cross-chain-state: an EIP-7702 delegated account is a wallet, not a contract', async (t) => {
  withKey(t);
  resetRpcCache();
  stubAnkr(t, {
    eth: (method) => (method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0xef0100' + 'b'.repeat(40)),
  });
  const server = startServer(t);
  const body = await (await fetch(`${server}/cross-chain-state?address=${ADDRESS}&chains=eth`)).json();
  assert.equal(body.results[0].is_contract, false);
  assert.equal(body.results[0].eip7702_delegated, true);
  assert.match(body.summary, /wallet with EIP-7702 delegation/);
});

test('cross-chain-state: an ENS name is answered honestly as unresolved', async (t) => {
  withKey(t);
  const server = startServer(t);
  const body = await (await fetch(`${server}/cross-chain-state?address=vitalik.eth`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /is an ENS name/);
});

test('cross-chain-state: every chain failing is a real 502, not a fake answer', async (t) => {
  withKey(t);
  resetRpcCache();
  stubAnkr(t, { eth: () => { throw new Error('down'); }, base: () => { throw new Error('down'); } });
  const server = startServer(t);
  const res = await fetch(`${server}/cross-chain-state?address=${ADDRESS}&chains=eth,base`);
  assert.equal(res.status, 502);
});
