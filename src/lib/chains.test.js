import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAINS, resolveChain, resolveChainLoose } from './chains.js';

test('resolveChain is unchanged: exact canonical keys only', () => {
  assert.equal(resolveChain('eth'), CHAINS.eth);
  assert.equal(resolveChain('ethereum'), null);
  assert.equal(resolveChain('Eth'), null);
});

test('resolveChainLoose accepts every canonical key resolveChain does', () => {
  for (const key of Object.keys(CHAINS)) {
    assert.equal(resolveChainLoose(key), CHAINS[key]);
  }
});

test('resolveChainLoose accepts full chain names and is case-insensitive', () => {
  assert.equal(resolveChainLoose('ethereum'), CHAINS.eth);
  assert.equal(resolveChainLoose('Ethereum'), CHAINS.eth);
  assert.equal(resolveChainLoose('ETHEREUM'), CHAINS.eth);
});

test('resolveChainLoose accepts common aliases', () => {
  assert.equal(resolveChainLoose('mainnet'), CHAINS.eth);
  assert.equal(resolveChainLoose('matic'), CHAINS.polygon);
  assert.equal(resolveChainLoose('arb'), CHAINS.arbitrum);
  assert.equal(resolveChainLoose('op'), CHAINS.optimism);
  assert.equal(resolveChainLoose('arbitrum one'), CHAINS.arbitrum);
});

test('resolveChainLoose extracts a chain name from a whole question', () => {
  assert.equal(resolveChainLoose('What is gas on Ethereum right now?'), CHAINS.eth);
  assert.equal(resolveChainLoose('how much does a transfer cost on Polygon'), CHAINS.polygon);
});

test('resolveChainLoose does not match a substring inside an unrelated word', () => {
  // "op" must not match inside "shop" or "opossum"
  assert.equal(resolveChainLoose('checking the shop prices'), null);
});

test('resolveChainLoose returns null for an unrecognized chain', () => {
  assert.equal(resolveChainLoose('solana'), null);
  assert.equal(resolveChainLoose(''), null);
  assert.equal(resolveChainLoose(undefined), null);
});
