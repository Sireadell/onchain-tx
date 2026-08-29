import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTxHash, extractAddress, extractHostname, tokenize } from './entityExtract.js';

const HASH = '0x' + '1'.repeat(64);
const ADDR = '0x' + 'a'.repeat(40);

test('extractTxHash finds a bare hash', () => {
  assert.equal(extractTxHash(HASH), HASH);
});

test('extractTxHash finds a hash wrapped in a question', () => {
  assert.equal(extractTxHash(`Is ${HASH} confirmed?`), HASH);
});

test('extractTxHash does not fire on a 40-hex address', () => {
  assert.equal(extractTxHash(ADDR), null);
});

test('extractTxHash returns null for garbage', () => {
  assert.equal(extractTxHash('vitalik.eth'), null);
  assert.equal(extractTxHash(undefined), null);
});

test('extractAddress finds a bare address', () => {
  assert.equal(extractAddress(ADDR), ADDR);
});

test('extractAddress finds an address wrapped in a question', () => {
  assert.equal(extractAddress(`How much ETH does ${ADDR} hold?`), ADDR);
});

test('extractAddress does not fire on the first 40 chars of a longer hash', () => {
  assert.equal(extractAddress(HASH), null);
});

test('extractHostname strips protocol and path from a full URL', () => {
  assert.equal(extractHostname('https://example.com/path'), 'example.com');
});

test('extractHostname strips a port from host:port', () => {
  assert.equal(extractHostname('github.com:443'), 'github.com');
});

test('extractHostname finds a hostname inside a sentence', () => {
  assert.equal(extractHostname('Is the SSL certificate for github.com valid?'), 'github.com');
});

test('extractHostname returns null when nothing domain-shaped is present', () => {
  assert.equal(extractHostname('is this thing secure'), null);
});

test('tokenize lowercases and splits on non-alphanumerics', () => {
  assert.deepEqual(tokenize('What is Bitcoin worth?'), ['what', 'is', 'bitcoin', 'worth']);
});

test('tokenize returns empty array for non-string input', () => {
  assert.deepEqual(tokenize(undefined), []);
});
