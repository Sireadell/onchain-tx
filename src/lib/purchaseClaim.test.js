import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClaim, checkClaim } from './purchaseClaim.js';

test('reads order, merchant, items and total from a claim', () => {
  const c = readClaim("Can you verify order #AZX789-B345 from 'The Gadget Hub'? The receipt shows two items: a 'Wireless Mouse' for $25.99 and a 'USB-C Hub' for $49.50, with a total of $75.49. Was the payment authorized?");
  assert.equal(c.order, 'AZX789-B345');
  assert.equal(c.merchant, 'The Gadget Hub');
  assert.equal(c.total, 75.49);
  assert.deepEqual(c.items.map((i) => i.price), [25.99, 49.5]);
});

test('does not read "purchase from" as an order id, and reads four-digit totals', () => {
  const c = readClaim('Can you verify my purchase from Best Buy, order number 987-6543210? I want a Samsung TV for $799.99, a soundbar for $199.99, and a total charge of $1025.67.');
  assert.equal(c.order, '987-6543210');
  assert.equal(c.total, 1025.67);
});

test('reports unverified, with the arithmetic', () => {
  const ok = checkClaim("Verify order #GH789012 from 'The Gadget Hub': 'Ultra-Sonic Cleaner' for $79.99 and 'Smart Mug' for $49.99, total $129.98.");
  assert.equal(ok.verdict, 'Unverified');
  assert.equal(ok.arithmetic.adds_up, true);
  const off = checkClaim('Verify order 987-6543210 from Best Buy: a TV for $799.99 and a soundbar for $199.99, with a total of $1025.67.');
  assert.equal(off.arithmetic.adds_up, false);
  assert.equal(off.arithmetic.difference, 25.69);
});
