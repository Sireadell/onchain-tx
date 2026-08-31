import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntents, extractRequestText } from './misrouteWatch.js';

test('misroute watcher reads a whole question from a primary route parameter', () => {
  const text = extractRequestText({
    method: 'GET',
    query: { location: `What is the balance of 0x${'a'.repeat(40)}?` },
  });
  assert.match(text, /balance/);
  assert.deepEqual(detectIntents(text).map((hit) => hit.intent), ['WALLET_BALANCE_CHECK']);
});

test('misroute watcher combines structured fields with free text evidence', () => {
  const text = extractRequestText({
    method: 'POST',
    body: { wallet: `0x${'b'.repeat(40)}`, prompt: 'Is this address a fraud risk?' },
  });
  assert.match(text, /0x/);
  assert.deepEqual(detectIntents(text).map((hit) => hit.intent), ['FRAUD_DETECTION']);
});
