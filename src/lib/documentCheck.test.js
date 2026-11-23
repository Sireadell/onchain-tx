import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { compareCopies, digestChecks, hex64s, inlineBlocks, urlsIn } from './documentCheck.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('a changed copy is caught and the changed words are shown', () => {
  const stored = 'AGREEMENT A-1\nFee: USD 42,000\nTerms: net 30 days';
  const sent = 'AGREEMENT A-1\nFee: USD 42,000\nTerms: net 60 days';
  const q = `Stored hash ${sha(stored)}. The supplier sent <<< ${sent} >>> and the signed copy is <<< ${stored} >>>. Hash each without a trailing newline.`;
  const r = compareCopies(q);
  assert.equal(r.authentic, false);
  assert.match(r.answer, /net 60/);
  assert.match(r.answer, /net 30/);
});

test('a matching copy with one trailing newline passes when the question says to add it', () => {
  const body = 'LIST PL-1\nItems: 88 crates';
  const q = `Stored SHA-256: ${sha(`${body}\n`)} <<< ${body} >>> Remember to add the final newline when hashing.`;
  const r = compareCopies(q);
  assert.equal(r.authentic, true);
});

test('stored and received hashes that differ fail the integrity check', () => {
  const q = `Stored SHA-256: ${'a'.repeat(63)}b SHA-256 of the file as received: ${'c'.repeat(63)}d <<< x: 1 >>>`;
  const r = compareCopies(q);
  assert.equal(r.authentic, false);
  assert.match(r.answer, /must fail/);
});

test('a broken hash chain and two unequal digests are reported', () => {
  const chain = 'Event 1 hash H1 = 4a11...88c2; Event 2 records prev_hash = 4a11...88c2 and H2 = 9c30...11a4; Event 3 records prev_hash = 7f00...dead and H3 = 2b88...55e1.';
  const r = digestChecks(chain);
  assert.match(r.answer, /broken at Event 3/);
  const d1 = sha('one');
  const d2 = `${d1.slice(0, 60)}9999`;
  const r2 = digestChecks(`Document payload SHA-256 is ${d1}, but the signed payload digest is ${d2}.`);
  assert.match(r2.answer, /differ in 4 of 64/);
});

test('helpers read blocks, hashes and links', () => {
  assert.deepEqual(inlineBlocks('a <<< one >>> b <<< two >>>'), ['one', 'two']);
  assert.equal(hex64s(`x ${'AB'.repeat(32)} y`).length, 1);
  assert.deepEqual(urlsIn('see https://example.com/a.pdf, ok'), ['https://example.com/a.pdf']);
});
