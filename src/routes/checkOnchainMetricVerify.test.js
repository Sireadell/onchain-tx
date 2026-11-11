import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRpcCache } from '../lib/ankrRpc.js';

const CONTRACT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const OWNER = `0x${'ab'.repeat(20)}`;

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

// handler(method, params) returns the JSON-RPC result, or throws for an error.
function stubRpc(t, handler) {
  process.env.ANKR_API_KEY = 'test-key';
  delete process.env.DWELLIR_API_KEY;
  resetRpcCache();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://rpc.ankr.com/')) return original(url, init);
    const { method, params } = JSON.parse(init.body);
    calls.push({ segment: String(url).split('/')[3], method, params });
    try {
      const result = handler(method, params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: err.message } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const addressWord = (a) => `0x${'0'.repeat(24)}${a.slice(2)}`;
const ask = async (base, q) => (await fetch(`${base}/onchain-metric-verify?question=${encodeURIComponent(q)}`)).json();

test('a contract view is read at the named block', async (t) => {
  const calls = stubRpc(t, (method) => {
    if (method === 'eth_call') return addressWord(OWNER);
    throw new Error(`unexpected ${method}`);
  });
  const j = await ask(startServer(t), `value of owner() at ${CONTRACT}, Polygon, block number 61,000,000`);
  assert.equal(j.status, 'ok');
  assert.match(j.summary, new RegExp(`On Polygon at block 61,000,000, the contract ${CONTRACT} answered: owner\\(\\) gave ${OWNER}`));
  assert.equal(calls[0].segment, 'polygon');
  assert.equal(calls[0].params[1], `0x${(61_000_000).toString(16)}`);
  assert.equal(calls[0].params[0].data, '0x8da5cb5b');
});

test('an NFT owner question builds ownerOf with the token id', async (t) => {
  const calls = stubRpc(t, () => addressWord(OWNER));
  const j = await ask(startServer(t), `Which wallet held BAYC id 100 (contract ${CONTRACT}) when block 20,900,000 was current?`);
  assert.match(j.summary, /ownerOf\(100\) gave/);
  assert.equal(calls[0].params[0].data, `0x6352211e${(100).toString(16).padStart(64, '0')}`);
});

test('a raw storage slot is returned as a word', async (t) => {
  const word = `0x${'0'.repeat(62)}2a`;
  const calls = stubRpc(t, (method) => {
    assert.equal(method, 'eth_getStorageAt');
    return word;
  });
  const j = await ask(startServer(t), `Give the hex word stored at position 0x8 in ${CONTRACT} on Ethereum, historical block 19,300,000.`);
  assert.match(j.summary, new RegExp(`slot 0x8 of ${CONTRACT} on Ethereum at block 19,300,000 is ${word} \\(as an integer 42\\)`));
  assert.deepEqual(calls[0].params, [CONTRACT, '0x8', `0x${(19_300_000).toString(16)}`]);
});

test('transaction gas is read from the receipt', async (t) => {
  const hash = `0x${'cd'.repeat(32)}`;
  stubRpc(t, () => ({ gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', blockNumber: '0x64', logs: [{}, {}] }));
  const j = await ask(startServer(t), `How much gas did ${hash} use on Base?`);
  assert.match(j.summary, /used 21,000 gas \(21000\) at an effective gas price of 1 gwei/);
  assert.match(j.summary, /emitted 2 logs/);
});

test('a native balance at a block', async (t) => {
  const wallet = `0x${'12'.repeat(20)}`;
  const calls = stubRpc(t, () => '0xde0b6b3a7640000');
  const j = await ask(startServer(t), `What was the ETH balance of ${wallet} at block 18,000,000?`);
  assert.match(j.summary, /balance of .* on Ethereum at block 18,000,000 is 1 ETH/);
  assert.equal(calls[0].method, 'eth_getBalance');
});

test('a bare address with a block reads its native balance, and Gwei is given when asked', async (t) => {
  const wallet = `0x${'12'.repeat(20)}`;
  const calls = stubRpc(t, () => '0xde0b6b3a7640000');
  const base = startServer(t);
  const bare = await (await fetch(`${base}/onchain-metric-verify?address=${wallet}&block=18000000`)).json();
  assert.equal(bare.status, 'ok');
  assert.equal(bare.kind, 'native_balance');
  assert.match(bare.summary, /is 1 ETH/);
  const gwei = await ask(base, `What is the Ethereum balance in Gwei of address ${wallet} at block 18000000?`);
  assert.match(gwei.summary, /\(1000000000 gwei\)/);
  assert.equal(calls[0].method, 'eth_getBalance');
});

test('history the node cannot serve falls back to the latest block and says so', async (t) => {
  stubRpc(t, (method, params) => {
    if (params[1] !== 'latest') throw new Error('missing trie node');
    return addressWord(OWNER);
  });
  const j = await ask(startServer(t), `owner() of ${CONTRACT} at block 1,000,000`);
  assert.match(j.summary, /Historical state at block 1,000,000 was not available/);
  assert.equal(j.confidence, 0.4);
  assert.equal(j.block, 'latest');
});

test('a contract with no such view is reported, not guessed', async (t) => {
  stubRpc(t, () => '0x');
  const j = await ask(startServer(t), `owner() of ${CONTRACT}`);
  assert.equal(j.status, 'invalid_input');
  assert.match(j.summary, /no such view or it reverted/);
});

test('a question with nothing readable asks for a contract and a view', async (t) => {
  const j = await ask(startServer(t), 'how is the weather');
  assert.equal(j.status, 'invalid_input');
  assert.match(j.summary, /which on-chain value to read/);
});
