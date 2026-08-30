import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAddress, describeAddressMiss } from './addressContext.js';
import { resetRpcCache, withRpcBudget } from './ankrRpc.js';

// The address from live signal 0xb400cf7e, the one that provoked all of
// this. Verified against Ethereum 2026-08-30: no contract code, so it is a
// plain wallet, and it held 124418.24535247098019573 ETH at the time.
const BINANCE_WALLET = '0x28C6c06298d514Db089934071355E5743bf21d60';
const USDC_CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// Ankr is stubbed at the fetch layer so these run without a key and
// without network. The local key 403s on every method, so end-to-end
// verification happens against production, not here.
function stubRpc(t, byMethod) {
  const realFetch = global.fetch;
  const previousKey = process.env.ANKR_API_KEY;
  process.env.ANKR_API_KEY = 'test-key';
  resetRpcCache();
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://rpc.ankr.com/')) return realFetch(url, opts);
    const { method } = JSON.parse(opts.body);
    const handler = byMethod[method];
    if (handler === undefined) return new Response('forbidden', { status: 403 });
    if (handler instanceof Error) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: handler.message } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: handler }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = realFetch;
    if (previousKey === undefined) delete process.env.ANKR_API_KEY;
    else process.env.ANKR_API_KEY = previousKey;
    resetRpcCache();
  });
}

test('an address with no code is identified as a wallet, with its balance', async (t) => {
  stubRpc(t, {
    eth_getCode: '0x',
    eth_getBalance: '0x1a58ba0227f4e451f592', // 124418.2453... ETH, read live
  });

  const info = await withRpcBudget(() => classifyAddress('eth', BINANCE_WALLET));

  assert.equal(info.kind, 'wallet');
  assert.equal(info.balanceEth, '124418.24535247098019573');
});

test('an address with code is identified as a contract, not a wallet', async (t) => {
  stubRpc(t, { eth_getCode: '0x60806040523480156100105760' });

  const info = await withRpcBudget(() => classifyAddress('eth', USDC_CONTRACT));

  assert.equal(info.kind, 'contract');
});

test('the wallet answer states what the address is, in the words of the question', async (t) => {
  stubRpc(t, { eth_getCode: '0x', eth_getBalance: '0x1a58ba0227f4e451f592' });

  const summary = await withRpcBudget(
    () => describeAddressMiss('eth', BINANCE_WALLET, 'Ethereum', 'total value locked'),
  );

  // The sentence has to answer the question that was asked, which means
  // using its vocabulary. This is the whole point: a TVL question gets a
  // sentence about total value locked, not about a missing price.
  assert.match(summary, /is a wallet address on Ethereum/);
  assert.match(summary, /no total value locked/);
  assert.match(summary, /124418.245/);
  // Plain decimal, never comma-grouped: verified against the live TVL
  // scorer that comma-grouped figures score near zero.
  assert.doesNotMatch(summary, /\d,\d/);
});

test('a contract that simply has no price says so without calling it a wallet', async (t) => {
  stubRpc(t, { eth_getCode: '0x6080604052' });

  const summary = await withRpcBudget(
    () => describeAddressMiss('eth', USDC_CONTRACT, 'Ethereum', 'token price'),
  );

  assert.match(summary, /is a contract on Ethereum/);
  assert.doesNotMatch(summary, /wallet/);
});

test('a wallet whose balance cannot be read is still identified as a wallet', async (t) => {
  stubRpc(t, { eth_getCode: '0x', eth_getBalance: new Error('rpc exploded') });

  const summary = await withRpcBudget(
    () => describeAddressMiss('eth', BINANCE_WALLET, 'Ethereum', 'token price'),
  );

  assert.match(summary, /is a wallet address on Ethereum/);
  // No balance clause, rather than a fabricated or zero one.
  assert.doesNotMatch(summary, /currently holds/);
});

test('when the chain call fails entirely, nothing is invented', async (t) => {
  stubRpc(t, {}); // every method 403s, as the local key really does

  assert.equal(await withRpcBudget(() => classifyAddress('eth', BINANCE_WALLET)), null);
  // null means the caller keeps its original refusal, which is honest.
  assert.equal(
    await withRpcBudget(() => describeAddressMiss('eth', BINANCE_WALLET, 'Ethereum', 'token price')),
    null,
  );
});

test('a malformed address is rejected without spending an RPC call', async (t) => {
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async (...args) => { calls += 1; return realFetch(...args); };
  t.after(() => { global.fetch = realFetch; });

  assert.equal(await classifyAddress('eth', 'not-an-address'), null);
  assert.equal(await classifyAddress('eth', null), null);
  assert.equal(calls, 0);
});
