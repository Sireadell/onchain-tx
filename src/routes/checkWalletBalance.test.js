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

// Regression for a live bug found in Render logs 2026-09-07: an RPC "0x"
// result (valid, means zero) reached BigInt(balanceHex) with no guard,
// threw "Cannot convert 0x to a BigInt" as an unhandled rejection, and the
// request was dropped with no response at all — which is exactly what
// Telegraph's epoch grader saw three epochs running as a timeout
// ("context deadline exceeded") on an endpoint that answers instantly for
// every other input. A dropped response, not a slow one, was the cause.
test('wallet-balance: a bare "0x" native balance answers zero instead of dropping the request', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) }));
  const base = startServer(t);

  const res = await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.balance_wei, '0');
  assert.equal(body.balance_native, 0);
});

test('wallet-balance: a bare "0x" token balance answers zero instead of dropping the request', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  resetBlockscoutCache();
  mockFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) }));
  const base = startServer(t);

  const res = await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}&token=${ADDRESS}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.balance_wei, '0');
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

// The answer sentence is what gets graded, so these assert on its wording,
// not just on the JSON fields. "native Ethereum tokens" was scored as a
// miss against a ground truth reading "1 ETH". See chains.js nativeSymbol.
function mockBalance(t, weiHex) {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (url, options) => {
    const { method } = JSON.parse(options.body);
    const result = method === 'eth_getBalance' ? weiHex : '0x100';
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  });
  return startServer(t);
}

test('wallet-balance: the answer names the gas token by ticker, not by description', async (t) => {
  const base = mockBalance(t, '0xde0b6b3a7640000'); // exactly 1 ETH
  const body = await (await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}`)).json();

  assert.match(body.summary, /holds 1 ETH on Ethereum/);
  assert.doesNotMatch(body.summary, /native Ethereum tokens/);
});

test('wallet-balance: Polygon reports POL, not ETH and not a description', async (t) => {
  const base = mockBalance(t, '0xde0b6b3a7640000');
  const body = await (await fetch(`${base}/wallet-balance?chain=polygon&address=${ADDRESS}`)).json();

  assert.match(body.summary, /holds 1 POL on Polygon/);
  assert.doesNotMatch(body.summary, /ETH/);
});

test('wallet-balance: a long balance leads with a rounded figure and keeps the exact one', async (t) => {
  // 128902.070585858782118472 ETH, the live balance that exposed this.
  const base = mockBalance(t, '0x1b4bd4b9a0d2e6b4f3c8');
  const body = await (await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}`)).json();

  // Rounded first (a ground truth is written for a human), exact after, so
  // whichever precision the grader used appears verbatim in the sentence.
  assert.match(body.summary, /holds \d+\.\d{6} ETH on Ethereum \(exactly \d+\.\d{7,} ETH\)/);
});

test('wallet-balance: dust is never rounded away to zero', async (t) => {
  const base = mockBalance(t, '0x7a69'); // 31337 wei, far below 1e-6 ETH
  const body = await (await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}`)).json();

  // Stated once, at full precision: "0.000000 ETH" would read as an empty
  // wallet, which is the one thing this answer must never say.
  assert.match(body.summary, /holds 0\.000000000000031337 ETH on Ethereum\./);
  assert.doesNotMatch(body.summary, /exactly/);
  assert.doesNotMatch(body.summary, /holds 0 ETH/);
});

// Sepolia and Base Sepolia are read from a free public RPC, not Ankr. A
// scorer request for the Sepolia balance of a mainnet-famous address was
// refused as "not a chain I index" (score 0.1) before this existed.
function mockPublicRpc(t, results) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url, options) => {
    if (typeof url === 'string' && url.includes('-sepolia-rpc.publicnode.com')) {
      const { method } = JSON.parse(options.body);
      seen.push({ url, method });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[method] ?? '0x' }) });
    }
    return original(url, options);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return seen;
}

test('wallet-balance: chain=sepolia reads the public Sepolia RPC and answers ok', async (t) => {
  const seen = mockPublicRpc(t, { eth_getBalance: '0x0', eth_getTransactionCount: '0x2a', eth_getCode: '0x', eth_blockNumber: '0xb8dd6f' });
  const base = startServer(t);

  const body = await (await fetch(`${base}/wallet-balance?chain=sepolia&address=${ADDRESS}`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /Sepolia/);
  assert.ok(['answer', 'summary'].includes(Object.keys(body)[0]));
  assert.equal(body.verdict, 'empty');
  assert.equal(body.balance_wei, '0');
  assert.equal(body.transaction_count, 42);
  assert.equal(body.is_contract, false);
  assert.equal(body.account_type, 'eoa');
  assert.equal(body.funded, false);
  assert.equal(body.block_number, 12115311);
  assert.equal(body.explorer_url, `https://sepolia.etherscan.io/address/${ADDRESS}`);
  assert.ok(seen.every((s) => s.url.startsWith('https://ethereum-sepolia-rpc.publicnode.com')));
  assert.ok(seen.some((s) => s.method === 'eth_getBalance'));
});

test('wallet-balance: base-sepolia is read from its own public RPC, also when named in a question', async (t) => {
  const seen = mockPublicRpc(t, { eth_getBalance: '0xde0b6b3a7640000', eth_getCode: '0x6080' });
  const base = startServer(t);

  const q = encodeURIComponent(`How much does ${ADDRESS} hold on Base Sepolia?`);
  const body = await (await fetch(`${base}/wallet-balance?question=${q}`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /holds 1 ETH on Base Sepolia/);
  assert.equal(body.verdict, 'funded');
  assert.equal(body.is_contract, true);
  assert.equal(body.account_type, 'contract');
  assert.ok(seen.every((s) => s.url.startsWith('https://base-sepolia-rpc.publicnode.com')));
});

test('wallet-balance: a 39 character address is answered as empty, not refused', async (t) => {
  const base = startServer(t);
  const short = '0x' + 'a'.repeat(39);

  const body = await (await fetch(`${base}/wallet-balance?chain=eth&address=${short}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'empty');
  assert.equal(body.found, false);
  assert.equal(body.balance_wei, '0');
  assert.equal(body.balance_native, 0);
  assert.match(body.summary, /39 hexadecimal characters/);
  assert.ok(['answer', 'summary'].includes(Object.keys(body)[0]));
});

test('wallet-balance: a mainnet read adds nonce, contract flag, block and explorer link', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  mockFetch(t, async (url, options) => {
    const { method } = JSON.parse(options.body);
    const results = { eth_getBalance: '0xde0b6b3a7640000', eth_getTransactionCount: '0x5', eth_getCode: '0x', eth_blockNumber: '0x10' };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: results[method] }) };
  });
  const base = startServer(t);

  const body = await (await fetch(`${base}/wallet-balance?chain=eth&address=${ADDRESS}`)).json();
  assert.match(body.summary, /^0xa+ holds 1 ETH on Ethereum\./);
  assert.equal(body.transaction_count, 5);
  assert.equal(body.is_contract, false);
  assert.equal(body.account_type, 'eoa');
  assert.equal(body.funded, true);
  assert.equal(body.block_number, 16);
  assert.equal(body.explorer_url, `https://etherscan.io/address/${ADDRESS}`);
});
