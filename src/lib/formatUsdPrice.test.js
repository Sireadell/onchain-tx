import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsdPrice } from './formatUsdPrice.js';

test('formatUsdPrice: a dollar or more stays at cent precision, with no separators', () => {
  assert.equal(formatUsdPrice(79394.93839787605), '79394.94');
  assert.equal(formatUsdPrice(319.97), '319.97');
  assert.equal(formatUsdPrice(1), '1.00');
  assert.equal(formatUsdPrice(2.5), '2.50');
});

test('formatUsdPrice: a sub-dollar coin keeps its significant figures', () => {
  assert.equal(formatUsdPrice(0.08953364), '0.08953');
  assert.equal(formatUsdPrice(0.000012345), '0.00001234');
  assert.equal(formatUsdPrice(0.0000486712), '0.00004867');
});

test('formatUsdPrice: never drops below cent precision', () => {
  assert.equal(formatUsdPrice(0.5), '0.50');
  assert.equal(formatUsdPrice(0.99), '0.99');
  assert.equal(formatUsdPrice(0), '0.00');
});

test('formatUsdPrice: a value that is not a number has no formatting', () => {
  assert.equal(formatUsdPrice(NaN), null);
  assert.equal(formatUsdPrice(undefined), null);
});
