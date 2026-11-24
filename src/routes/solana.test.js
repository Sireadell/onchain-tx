import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetSolanaCache } from '../lib/solanaRpc.js';

const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const MOCK_URL = 'https://mock-solana.test/rpc';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

// handlers: { method: (params) => result | { error } }
function mockSolana(t, handlers) {
  resetSolanaCache();
  const prev = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = MOCK_URL;
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.startsWith(MOCK_URL)) {
      const { method, params } = JSON.parse(init.body);
      calls.push(method);
      const h = handlers[method];
      const out = h ? h(params) : { error: { message: `no mock for ${method}` } };
      const body = out && out.error ? { jsonrpc: '2.0', id: 1, error: out.error } : { jsonrpc: '2.0', id: 1, result: out };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    if (typeof url === 'string' && url.includes('coins.llama.fi')) throw new Error('no price in tests');
    return original(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
    if (prev === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = prev;
    resetSolanaCache();
  });
  return calls;
}

test('solana balance: native SOL from lamports', async (t) => {
  mockSolana(t, { getBalance: () => ({ context: { slot: 1 }, value: 9000000431692335 }) });
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?address=${WALLET}&chain=solana`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.chain, 'solana');
  assert.match(body.summary, /holds 9000000\.431692 SOL on Solana \(exactly 9000000\.431692335 SOL\)/);
  assert.equal(body.balance_lamports, '9000000431692335');
  assert.equal(body.canonical, `solana:${WALLET}:9000000431692335`);
  assert.ok(body.as_of);
});

test('solana balance: a question with the address and the word Solana, no chain param', async (t) => {
  mockSolana(t, { getBalance: () => ({ value: 2500000000 }) });
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?question=${encodeURIComponent(`What is the SOL balance of ${WALLET}?`)}`);
  const body = await res.json();
  assert.match(body.summary, /holds 2\.5 SOL on Solana/);
});

test('solana balance: USDC by symbol sums token accounts', async (t) => {
  const seen = [];
  mockSolana(t, {
    getTokenAccountsByOwner: (p) => {
      seen.push(p);
      const row = (amount) => ({ account: { data: { parsed: { info: { tokenAmount: { amount, decimals: 6 } } } } } });
      return { value: [row('1500000'), row('2500000')] };
    },
  });
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?address=${WALLET}&token=USDC&chain=solana`);
  const body = await res.json();
  assert.equal(seen[0][1].mint, USDC);
  assert.match(body.summary, /holds 4 USDC on Solana/);
  assert.equal(body.balance_raw, '4000000');
  assert.equal(body.token_accounts, 2);
});

test('solana balance: wallet and mint both written in the question', async (t) => {
  mockSolana(t, { getTokenAccountsByOwner: () => ({ value: [] }), getTokenSupply: () => ({ value: { amount: '1', decimals: 6 } }) });
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?question=${encodeURIComponent(`Solana token balance of ${WALLET} for mint ${USDC}`)}`);
  const body = await res.json();
  assert.equal(body.address, WALLET);
  assert.equal(body.token, USDC);
  assert.match(body.summary, /holds 0 USDC/);
});

test('solana balance: no wallet gives guidance, not a crash', async (t) => {
  const calls = mockSolana(t, {});
  const base = startServer(t);
  const body = await (await fetch(`${base}/wallet-balance?chain=solana`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.equal(calls.length, 0);
});

test('solana supply: mint supply with decimals', async (t) => {
  mockSolana(t, { getTokenSupply: () => ({ value: { amount: '8000000000000000', decimals: 6, uiAmountString: '8000000000' } }) });
  const base = startServer(t);
  const body = await (await fetch(`${base}/token-total-supply?token=${USDC}&chain=solana`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.symbol, 'USDC');
  assert.equal(body.decimals, 6);
  assert.equal(body.total_supply, '8000000000');
  assert.match(body.summary, /total supply of USDC \(EPjF.*\) on Solana is 8,000,000,000 USDC/);
  assert.equal(body.canonical, `token-total-supply:solana:${USDC}:8000000000000000`);
});

test('solana supply: native SOL when no mint is named', async (t) => {
  mockSolana(t, { getSupply: () => ({ value: { total: 600000000000000000, circulating: 500000000000000000 } }) });
  const base = startServer(t);
  const body = await (await fetch(`${base}/token-total-supply?question=${encodeURIComponent('What is the total supply of SOL on Solana?')}`)).json();
  assert.equal(body.native, true);
  assert.equal(body.total_supply, '600000000');
});

test('solana supply: an address that is not a mint is answered, not faked', async (t) => {
  mockSolana(t, { getTokenSupply: () => ({ error: { message: 'Invalid param: not a Token mint' } }) });
  const base = startServer(t);
  const body = await (await fetch(`${base}/token-total-supply?token=${WALLET}&chain=solana`)).json();
  assert.equal(body.found, false);
  assert.equal(body.total_supply, null);
});

test('solana holders: never states a count, says why, adds concentration', async (t) => {
  mockSolana(t, {
    getTokenSupply: () => ({ value: { amount: '1000000000000', decimals: 9, uiAmountString: '1000' } }),
    getTokenLargestAccounts: () => ({ value: [{ address: 'A', amount: '400000000000', uiAmountString: '400' }, { address: 'B', amount: '100000000000', uiAmountString: '100' }] }),
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/token-holders?question=${encodeURIComponent(`How many holders does ${WSOL} have on Solana?`)}`)).json();
  assert.equal(body.holders_count, null);
  assert.equal(body.found, false);
  assert.equal(body.verdict, 'unavailable');
  assert.match(body.summary, /not available/);
  assert.match(body.summary, /not a holder count/);
  assert.equal(body.top_accounts.share_of_supply_percent, 50);
  assert.equal(body.canonical, `solana:${WSOL}:-`);
});

test('solana holders: not a mint', async (t) => {
  mockSolana(t, { getTokenSupply: () => ({ error: { message: 'not a Token mint' } }) });
  const base = startServer(t);
  const body = await (await fetch(`${base}/token-holders?token=${WALLET}&chain=solana`)).json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.holders_count, null);
});

test('solana tx: confirmed with slot, time and fee', async (t) => {
  mockSolana(t, {
    getSignatureStatuses: () => ({ value: [{ slot: 400, confirmations: null, err: null, confirmationStatus: 'finalized' }] }),
    getTransaction: () => ({ slot: 400, blockTime: 1700000000, meta: { err: null, fee: 5000, computeUnitsConsumed: 150 }, transaction: { message: { accountKeys: [{ pubkey: WALLET, signer: true }] } } }),
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/check-tx?tx_hash=${SIG}`)).json();
  assert.equal(body.status, 'confirmed');
  assert.equal(body.slot, 400);
  assert.equal(body.fee_lamports, 5000);
  assert.equal(body.fee_native, '0.000005');
  assert.equal(body.from, WALLET);
  assert.equal(body.block_time_iso, '2023-11-14T22:13:20.000Z');
  assert.equal(body.canonical, `solana:${SIG}:confirmed:400:1700000000:success`);
  assert.match(body.summary, /is confirmed \(finalized\), in slot 400/);
});

test('solana tx: failed transaction reports the error', async (t) => {
  mockSolana(t, {
    getSignatureStatuses: () => ({ value: [{ slot: 9, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] }),
    getTransaction: () => ({ slot: 9, blockTime: 1700000000, meta: { err: { InstructionError: [0, 'Custom'] }, fee: 5000 }, transaction: { message: { accountKeys: [WALLET] } } }),
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/check-tx?question=${encodeURIComponent(`Did ${SIG} succeed on Solana?`)}`)).json();
  assert.equal(body.status, 'failed');
  assert.equal(body.receipt_status, 'failed');
  assert.match(body.summary, /on Solana failed \(it landed on-chain/);
});

test('solana tx: unknown signature is not_found', async (t) => {
  mockSolana(t, { getSignatureStatuses: () => ({ value: [null] }), getTransaction: () => null });
  const base = startServer(t);
  const body = await (await fetch(`${base}/check-tx?tx_hash=${SIG}&chain=solana`)).json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.found, false);
});

test('solana: upstream outage is a 502, and no key reaches the response', async (t) => {
  mockSolana(t, {});
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/mock-solana|publicnode|mainnet-beta|dwellir/.test(String(url))) throw new Error('boom');
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  process.env.SOLANA_RPC_URL = 'https://mock-solana.test/rpc/SECRETKEY123';
  const base = startServer(t);
  const res = await fetch(`${base}/wallet-balance?address=${WALLET}&chain=solana`);
  assert.equal(res.status, 502);
  assert.equal((await res.text()).includes('SECRETKEY123'), false);
});

test('evm requests are untouched: a 0x address with chain=solana stays on the EVM path', async (t) => {
  const calls = mockSolana(t, {});
  const base = startServer(t);
  const res = await fetch(`${base}/token-holders?chain=solana&token=0x${'a'.repeat(40)}`);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(calls.length, 0);
});
