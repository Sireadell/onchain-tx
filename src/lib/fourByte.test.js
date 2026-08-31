import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupMethodSignature, resetMethodSignatureCache } from './fourByte.js';

test('decodes a contract method selector', async (t) => {
  resetMethodSignatureCache();
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url) => {
    assert.match(String(url), /hex_signature=0xe63d38ed/);
    return new Response(JSON.stringify({ results: [{ text_signature: 'disperseEther(address[],uint256[])' }] }));
  };
  assert.equal(
    await lookupMethodSignature('0xe63d38ed00000000'),
    'disperseEther(address[],uint256[])',
  );
});

test('returns null for a plain ETH transfer', async () => {
  assert.equal(await lookupMethodSignature('0x'), null);
});

test('uses the canonical ERC-20 transfer signature instead of a guessed directory result', async (t) => {
  resetMethodSignatureCache();
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    return new Response(JSON.stringify({ results: [{ text_signature: 'workMyDirefulOwner(uint256,uint256)' }] }));
  };
  t.after(() => { global.fetch = originalFetch; });

  assert.equal(
    await lookupMethodSignature(`0xa9059cbb${'0'.repeat(128)}`),
    'transfer(address,uint256)',
  );
  assert.equal(called, false);
});
