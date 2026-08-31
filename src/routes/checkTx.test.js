import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRpcCache } from '../lib/ankrRpc.js';

// Route-level tests for chain validation/isolation (allowlist enforcement,
// default-chain backward compatibility, cross-chain cache isolation) —
// the parts of Phase 11's isolation concern that live above the pure
// evaluator and aren't covered by txStatus.test.js or ankrRpc.test.js.

function startServer(t) {
  const server = buildApp().listen(0);
  // closeAllConnections is needed alongside close() — fetch's undici agent
  // keeps the connection alive by default, and a plain server.close() only
  // stops accepting new connections, it doesn't drop existing keep-alive
  // sockets. Without this the process never exits (open handle).
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// Only intercepts calls to Ankr — the test's own HTTP client call to the
// local server also goes through globalThis.fetch, so a blanket override
// would swallow that too.
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

test('unsupported chain is rejected before any RPC call', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const res = await fetch(`${base}/check-tx?chain=solana&tx_hash=0x${'1'.repeat(64)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.equal(body.error, undefined);
  assert.match(body.summary, /not a chain I index/);
  assert.equal(called, false);
});

test('omitted chain param falls back to default chain (backward compatible)', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: null }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/check-tx?tx_hash=0x${'2'.repeat(64)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.chain, 'eth');
  assert.equal(body.status, 'not_found');
});

test('same tx_hash on two different chains does not cross-contaminate responses', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (url, options) => {
    const chain = url.split('/')[3];
    const { method } = JSON.parse(options.body);
    let result = null;
    if (method === 'eth_blockNumber') {
      result = '0x100';
    } else if (chain === 'base') {
      result =
        method === 'eth_getTransactionByHash'
          ? { hash: '0xabc', from: '0x' + 'a'.repeat(40), value: '0x0', blockNumber: '0x1' }
          : null; // no receipt yet -> pending
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    };
  });
  const base = startServer(t);
  const hash = `0x${'3'.repeat(64)}`;

  const ethRes = await (await fetch(`${base}/check-tx?chain=eth&tx_hash=${hash}`)).json();
  const baseRes = await (await fetch(`${base}/check-tx?chain=base&tx_hash=${hash}`)).json();
  assert.equal(ethRes.status, 'not_found');
  assert.equal(baseRes.status, 'pending'); // has tx but no receipt in this mock
  assert.equal(ethRes.chain, 'eth');
  assert.equal(baseRes.chain, 'base');
});

test('a successful Base transaction is described as Base, not Ethereum', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === 'eth_getTransactionByHash'
      ? {
          hash: `0x${'6'.repeat(64)}`,
          from: `0x${'a'.repeat(40)}`,
          to: `0x${'b'.repeat(40)}`,
          value: '0xde0b6b3a7640000',
          input: '0x',
          blockNumber: '0x10',
        }
      : method === 'eth_getTransactionReceipt'
        ? { blockHash: `0x${'c'.repeat(64)}`, status: '0x1' }
        : '0x20';
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  });
  const base = startServer(t);
  const hash = `0x${'6'.repeat(64)}`;

  const body = await (await fetch(`${base}/check-tx?chain=base&tx_hash=${hash}`)).json();
  assert.equal(body.status, 'confirmed');
  assert.match(body.summary, /^Base transaction/);
  assert.match(body.summary, /sent 1 ETH/);
  assert.doesNotMatch(body.summary, /^Ethereum transaction/);
});

test('ERC-20 transfer selector is reported as canonical transfer', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (_url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === 'eth_getTransactionByHash'
      ? {
          hash: `0x${'7'.repeat(64)}`,
          from: `0x${'a'.repeat(40)}`,
          to: `0x${'b'.repeat(40)}`,
          value: '0x0',
          input: `0xa9059cbb${'0'.repeat(128)}`,
          blockNumber: '0x10',
        }
      : method === 'eth_getTransactionReceipt'
        ? { blockHash: `0x${'c'.repeat(64)}`, status: '0x1' }
        : '0x20';
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  });
  const base = startServer(t);
  const hash = `0x${'7'.repeat(64)}`;

  const body = await (await fetch(`${base}/check-tx?chain=eth&tx_hash=${hash}`)).json();
  assert.equal(body.method_signature, 'transfer(address,uint256)');
  assert.match(body.summary, /called transfer/);
  assert.doesNotMatch(body.summary, /workMyDirefulOwner/);
});

// Added 2026-08-30 after the live miner was found answering "no transaction
// hash was supplied" to a question that plainly contained one. The engine
// hands the caller's question through; the route only read tx_hash, so
// every free-text ONCHAIN_TX_LOOKUP request was refused.
test('a whole question is answered, with the chain it names', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  const seenChains = new Set();
  mockFetch(t, async (url) => {
    seenChains.add(url.split('/')[3]);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: null }) };
  });
  const base = startServer(t);
  const hash = `0x${'4'.repeat(64)}`;

  const question = encodeURIComponent(`Is transaction ${hash} on Base confirmed?`);
  const body = await (await fetch(`${base}/check-tx?question=${question}`)).json();
  assert.equal(body.status, 'not_found'); // reached the RPC rather than refusing
  assert.equal(body.tx_hash, hash);
  assert.equal(body.chain, 'base');
  assert.ok(seenChains.has('base'));
});

test('a question naming no chain still defaults to eth', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: null }),
  }));
  const base = startServer(t);
  const hash = `0x${'5'.repeat(64)}`;

  const question = encodeURIComponent(`what did ${hash} do?`);
  const body = await (await fetch(`${base}/check-tx?q=${question}`)).json();
  assert.equal(body.chain, 'eth');
  assert.equal(body.tx_hash, hash);
});

test('a question with no hash in it is still refused', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const body = await (await fetch(`${base}/check-tx?question=is+my+transaction+ok`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.equal(called, false);
});

test('Optimism is refused before RPC until the current Ankr key supports it', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const originalFlag = process.env.ANKR_ENABLE_OPTIMISM;
  delete process.env.ANKR_ENABLE_OPTIMISM;
  t.after(() => {
    if (originalFlag === undefined) delete process.env.ANKR_ENABLE_OPTIMISM;
    else process.env.ANKR_ENABLE_OPTIMISM = originalFlag;
  });
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const body = await (await fetch(`${base}/check-tx?chain=optimism&tx_hash=0x${'1'.repeat(64)}`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /current RPC provider/);
  assert.equal(called, false);
});
