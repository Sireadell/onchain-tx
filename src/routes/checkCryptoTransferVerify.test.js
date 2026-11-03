import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRpcCache } from '../lib/ankrRpc.js';
import { tipBlockFromText } from './checkCryptoTransferVerify.js';
import { TRANSFER_TOPIC } from '../lib/transferVerify.js';

const HASH = `0x${'ab'.repeat(32)}`;
const SENDER = `0x${'11'.repeat(20)}`;
const RECIPIENT = `0x${'22'.repeat(20)}`;

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

// Answers Ankr JSON-RPC calls from a small chain model.
function stubChain(t, { receiptStatus = '0x1', txKnown = true, logs = [] } = {}) {
  process.env.ANKR_API_KEY = 'test-key';
  delete process.env.DWELLIR_API_KEY;
  resetRpcCache();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://rpc.ankr.com/')) return original(url, init);
    const { method, params } = JSON.parse(init.body);
    calls.push({ segment: String(url).split('/')[3], method });
    const result = (() => {
      if (method === 'eth_getTransactionByHash') return txKnown ? { from: SENDER, to: RECIPIENT, value: '0xde0b6b3a7640000', blockNumber: '0x64', gas: '0x5208', gasPrice: '0x3b9aca00' } : null;
      if (method === 'eth_getTransactionReceipt') return txKnown ? { status: receiptStatus, blockNumber: '0x64', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs } : null;
      if (method === 'eth_getBlockByNumber') return params[0] === '0x64' ? { baseFeePerGas: '0x1dcd6500', timestamp: '0x3e8' } : { timestamp: '0x7d0' };
      if (method === 'eth_blockNumber') return '0x6e';
      throw new Error(`unexpected ${method}`);
    })();
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('tip block is read from the question, not from addresses or the hash', () => {
  assert.equal(tipBlockFromText(`Treat 280,000,000 as the chain tip for ${HASH}`), '280000000');
  assert.equal(tipBlockFromText('as of block 24,000,000 how old is it?'), '24000000');
  assert.equal(tipBlockFromText('Measure from block 60,000,000, counting the inclusion block'), '60000000');
  assert.equal(tipBlockFromText(`just ${HASH}`), null);
});

test('a successful transfer reports parties, amount, fee split and confirmations', async (t) => {
  stubChain(t);
  const base = startServer(t);
  const r = await fetch(`${base}/crypto-transfer-verify?question=${encodeURIComponent(`Did ${HASH} on Ethereum go through?`)}`);
  const j = await r.json();
  assert.equal(j.status, 'confirmed');
  assert.match(j.summary, /succeeded \(status 1\) in block 100 on Ethereum/);
  assert.match(j.summary, new RegExp(`Sender ${SENDER}; recipient ${RECIPIENT}`));
  assert.match(j.summary, /Native amount transferred: 1 ETH/);
  assert.match(j.summary, /Total fee: 0\.000021 ETH \(21,000,000,000,000 wei\)/);
  assert.match(j.summary, /Burned base fee: 10,500,000,000,000 wei/);
  assert.match(j.summary, /Confirmations: 11 counted against the latest block 110/);
  assert.equal(j.answer, j.summary);
});

test('a named tip block drives the confirmation count and elapsed time', async (t) => {
  stubChain(t);
  const base = startServer(t);
  const q = `As of block 50,000 on Ethereum, how deep is ${HASH}?`;
  const j = await (await fetch(`${base}/crypto-transfer-verify?question=${encodeURIComponent(q)}`)).json();
  assert.equal(j.confirmations, '49901');
  assert.match(j.summary, /Confirmations: 49,901 counted against block 50,000/);
  assert.match(j.summary, /Elapsed between the two blocks' timestamps: 1,000 seconds \(16 minutes 40 seconds\)/);
});

test('a reverted transfer says it failed', async (t) => {
  stubChain(t, { receiptStatus: '0x0' });
  const base = startServer(t);
  const j = await (await fetch(`${base}/crypto-transfer-verify?tx_hash=${HASH}&chain=eth`)).json();
  assert.equal(j.status, 'reverted');
  assert.match(j.summary, /failed \(status 0\) and was reverted/);
});

test('token transfers in the receipt are listed', async (t) => {
  const log = { address: `0x${'cc'.repeat(20)}`, topics: [TRANSFER_TOPIC, `0x${'0'.repeat(24)}${'11'.repeat(20)}`, `0x${'0'.repeat(24)}${'22'.repeat(20)}`], data: `0x${(5_000_000n).toString(16).padStart(64, '0')}` };
  stubChain(t, { logs: [log] });
  const original = globalThis.fetch;
  const wrapped = async (url, init) => {
    if (String(url).startsWith('https://rpc.ankr.com/') && JSON.parse(init.body).method === 'eth_call') {
      const data = JSON.parse(init.body).params[0].data;
      const result = data === '0x313ce567' ? `0x${(6).toString(16).padStart(64, '0')}` : `0x${'20'.padStart(64, '0')}${'3'.padStart(64, '0')}${Buffer.from('FOO').toString('hex').padEnd(64, '0')}`;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  globalThis.fetch = wrapped;
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const j = await (await fetch(`${base}/crypto-transfer-verify?tx_hash=${HASH}&chain=eth`)).json();
  assert.match(j.summary, /1 Transfer event in log order: 1\) 5 FOO from 0x1111/);
});

test('an unknown hash is reported as not found on every chain', async (t) => {
  stubChain(t, { txKnown: false });
  const base = startServer(t);
  const j = await (await fetch(`${base}/crypto-transfer-verify?question=${encodeURIComponent(`Verify ${HASH}`)}`)).json();
  assert.equal(j.status, 'not_found');
});

test('no hash is an unusable input, not a crash', async (t) => {
  const base = startServer(t);
  const j = await (await fetch(`${base}/crypto-transfer-verify?question=hello`)).json();
  assert.equal(j.status, 'invalid_input');
});
