import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEnsName, resolveEnsName, __clearEnsCacheForTesting } from './ensResolve.js';

test('findEnsName pulls a .eth name out of a question', () => {
  assert.equal(findEnsName("What is the ETH balance of the ENS name 'Vitalik.eth' on Base?"), 'vitalik.eth');
  assert.equal(findEnsName('balance of 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), null);
});

test('resolveEnsName answers a well-known name without the network', async () => {
  assert.equal(await resolveEnsName('vitalik.eth'), '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
});

test('resolveEnsName reads other names from the resolver API and caches them', async (t) => {
  __clearEnsCacheForTesting();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; __clearEnsCacheForTesting(); });
  assert.equal(await resolveEnsName('someone.eth'), '0x1111111111111111111111111111111111111111');
  assert.equal(await resolveEnsName('someone.eth'), '0x1111111111111111111111111111111111111111');
  assert.equal(calls, 1);
});
