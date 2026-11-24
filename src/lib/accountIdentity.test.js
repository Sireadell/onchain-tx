import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHandle, lookupAccount } from './accountIdentity.js';

test('reads the handle from a question', () => {
  assert.deepEqual(readHandle('Analyze the Twitter account @RepAdamSchiff for signs of bot activity'), { handle: 'RepAdamSchiff', platform: 'x' });
  assert.deepEqual(readHandle('Look at https://x.com/SpaceX please'), { handle: 'SpaceX', platform: 'x' });
  assert.equal(readHandle('no handle here'), null);
});

test('turns a Wikidata row into an identity', async () => {
  const fetchJson = async () => ({ results: { bindings: [{ item: { value: 'http://www.wikidata.org/entity/Q618236' }, itemLabel: { value: 'The Onion' }, itemDescription: { value: 'American satire news organization' } }] } });
  const r = await lookupAccount({ handle: 'TheOnionTest', platform: 'x' }, fetchJson);
  assert.equal(r.wikidata_id, 'Q618236');
  assert.equal(r.name, 'The Onion');
});
