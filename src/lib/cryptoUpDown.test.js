import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpDownQuestion, resolveCryptoUpDown, easternToUtcMs } from './cryptoUpDown.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const NOW = Date.UTC(2026, 10, 3, 12, 0);

test('winter and summer Eastern time convert to UTC', () => {
  assert.equal(new Date(easternToUtcMs(2026, 1, 28, 10, 15)).toISOString(), '2026-02-28T15:15:00.000Z');
  assert.equal(new Date(easternToUtcMs(2026, 6, 4, 10, 15)).toISOString(), '2026-07-04T14:15:00.000Z');
});

test('parses a range, a single hour, and rejects other questions', () => {
  const r = parseUpDownQuestion('Solana Up or Down - February 28, 10:15AM-10:30AM ET', NOW);
  assert.equal(r.asset.name, 'Solana');
  assert.equal(new Date(r.startMs).toISOString(), '2026-02-28T15:15:00.000Z');
  assert.equal(new Date(r.endMs).toISOString(), '2026-02-28T15:30:00.000Z');
  const h = parseUpDownQuestion('Bitcoin Up or Down - March 1, 3PM ET', NOW);
  assert.equal(h.endMs - h.startMs, 3_600_000);
  assert.equal(parseUpDownQuestion('Will it rain tomorrow?', NOW), null);
  assert.equal(parseUpDownQuestion('Foo Up or Down - March 1, 3PM ET', NOW), null);
});

function stubBinance(rows) {
  globalThis.fetch = async () => ({ ok: true, json: async () => rows });
}

test('resolves Up when the end price is at or above the start', async () => {
  const start = easternToUtcMs(2026, 1, 28, 10, 15);
  stubBinance(Array.from({ length: 15 }, (_, i) => [start + i * 60_000, String(100 + i), '0', '0', String(100.5 + i)]));
  const r = await resolveCryptoUpDown('Solana Up or Down - February 28, 10:15AM-10:30AM ET', NOW);
  assert.equal(r.outcome, 'up');
  assert.match(r.summary, /^Up, Solana rose/);
  assert.equal(r.open, 100);
  assert.equal(r.close, 114.5);
});

test('resolves Down when the price fell', async () => {
  const start = easternToUtcMs(2026, 1, 28, 10, 15);
  stubBinance(Array.from({ length: 15 }, (_, i) => [start + i * 60_000, String(100 - i), '0', '0', String(99 - i)]));
  const r = await resolveCryptoUpDown('Solana Up or Down - February 28, 10:15AM-10:30AM ET', NOW);
  assert.equal(r.outcome, 'down');
});

test('a window that has not ended is unresolved, and missing prices return null', async () => {
  const future = await resolveCryptoUpDown('Solana Up or Down - November 3, 11PM ET', NOW);
  assert.equal(future.outcome, 'unresolved');
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal(await resolveCryptoUpDown('Solana Up or Down - February 28, 10:15AM-10:30AM ET', NOW), null);
});
