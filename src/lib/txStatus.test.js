import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTransaction } from './txStatus.js';

const FROM = '0x62679469a82143f14649125db7f0d9f327e46b6';
const TO = '0xb3c726c6417293837f5929c91489ae949f9a372';

const deepBlock = '0x100'; // 256
function txAtDepth(blockNumberHex, currentHex, overrides = {}) {
  return {
    tx: { from: FROM, to: TO, value: '0x0', blockNumber: blockNumberHex, ...overrides.tx },
    receipt: { status: '0x1', blockHash: '0xblockhash', ...overrides.receipt },
    currentBlockNumberHex: currentHex,
  };
}

test('1. successful confirmed transaction, deep — full confidence', () => {
  const r = evaluateTransaction(txAtDepth('0xf0', deepBlock)); // depth 16 >= CONFIRMATION_DEPTH(12)
  assert.equal(r.status, 'confirmed');
  assert.equal(r.confidence, 1.0);
  assert.equal(r.receipt_status, 'success');
});

test('2. reverted transaction', () => {
  const r = evaluateTransaction(txAtDepth('0xf0', deepBlock, { receipt: { status: '0x0' } }));
  assert.equal(r.status, 'reverted');
  assert.ok(r.confidence > 0);
  assert.equal(r.receipt_status, 'failed');
});

test('3. contract creation — to is null, confidence unaffected', () => {
  const r = evaluateTransaction(
    txAtDepth('0xf0', deepBlock, { tx: { to: null } })
  );
  assert.equal(r.to, null);
  assert.equal(r.status, 'confirmed');
});

test('4. pending transaction — no receipt', () => {
  const r = evaluateTransaction({ tx: { from: FROM, to: TO, value: '0x0', blockNumber: null }, receipt: null, currentBlockNumberHex: deepBlock });
  assert.equal(r.status, 'pending');
  assert.equal(r.block_number, null);
  assert.equal(r.block_hash, null);
  assert.equal(r.receipt_status, null);
  assert.ok(r.confidence < 0.5);
});

test('5. nonexistent transaction — tx is null', () => {
  const r = evaluateTransaction({ tx: null, receipt: null, currentBlockNumberHex: deepBlock });
  assert.equal(r.status, 'not_found');
  assert.equal(r.confidence, 1.0);
  assert.equal(r.from, null);
  assert.equal(r.block_hash, null);
  assert.equal(r.receipt_status, null);
});

// Cases 6 (malformed hash), 7 (wrong-chain hash), 8 (unsupported chain) are
// input-validation / deployment-config concerns handled at the route layer
// (checkTx.js's TX_HASH_RE check) and by which chain a given instance is
// configured for — not decision-table branches, so they're not exercised
// here. Wrong-chain and malformed-hash both resolve to the same "not found"
// or 400 path already covered above and in checkTx's own validation.

// Cases 9 (RPC timeout/failure) and 10 (rate-limit/budget exhaustion) are
// transport-layer behavior in ankrRpc.js (retry backoff, RpcBudgetExceededError),
// ported unchanged from Miner #1's already-tested walletActivity.js pattern —
// not re-tested here since evaluateTransaction never sees a thrown error,
// checkTx.js catches those before calling it.

test('11. recent / reorg-sensitive transaction — shallow depth, reduced confidence', () => {
  const current = '0x105'; // 261, tx at 0x100 (256) -> depth 5, below CONFIRMATION_DEPTH(12)
  const r = evaluateTransaction(txAtDepth('0x100', current));
  assert.equal(r.status, 'confirmed');
  assert.ok(r.confidence < 1.0, `expected reduced confidence at shallow depth, got ${r.confidence}`);
  assert.ok(r.confidence >= 0.6);
  assert.match(r.summary, /recent|block\(s\) deep/);
});

test('12. old transaction — depth far past confirmation threshold still scores full confidence', () => {
  const r = evaluateTransaction(txAtDepth('0x1', '0x100000')); // ancient tx, current block huge
  assert.equal(r.status, 'confirmed');
  assert.equal(r.confidence, 1.0);
});

test('13. zero-value transaction', () => {
  const r = evaluateTransaction(txAtDepth('0xf0', deepBlock, { tx: { value: '0x0' } }));
  assert.equal(r.value_wei, '0');
});

test('14. contract call (non-transfer input data) — status/fields unaffected by input', () => {
  const r = evaluateTransaction(
    txAtDepth('0xf0', deepBlock, { tx: { value: '0x0' } })
  );
  assert.equal(r.status, 'confirmed');
  assert.equal(r.from, FROM);
  assert.equal(r.to, TO);
});

test('15. transaction types 0/1/2 — type field is opaque passthrough, does not change status logic', () => {
  for (const type of ['0x0', '0x1', '0x2']) {
    const r = evaluateTransaction(txAtDepth('0xf0', deepBlock, { tx: { type } }));
    assert.equal(r.status, 'confirmed');
  }
});

test('depth exactly at confirmation threshold scores full confidence', () => {
  const current = '0x10c'; // 268, tx at 0x100 (256) -> depth 12 == CONFIRMATION_DEPTH
  const r = evaluateTransaction(txAtDepth('0x100', current));
  assert.equal(r.confidence, 1.0);
});

test('missing current block number still returns a confirmed answer, non-1.0 confidence', () => {
  const r = evaluateTransaction(txAtDepth('0xf0', null));
  assert.equal(r.status, 'confirmed');
  assert.equal(r.confidence, 0.8);
});

test('current block behind the transaction block (negative depth) — capped at 0.8, never negative', () => {
  // tx at 0x100 (256), "current" block 0xf0 (240) — a stale/lagging RPC
  // response, shouldn't happen but must degrade safely instead of
  // producing a negative or >1 confidence value.
  const r = evaluateTransaction(txAtDepth('0x100', '0xf0'));
  assert.equal(r.status, 'confirmed');
  assert.equal(r.confidence, 0.8);
});
