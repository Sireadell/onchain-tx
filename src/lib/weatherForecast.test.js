import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSpentToday } from './weatherForecast.js';

// A day already nearly over cannot carry a real high or low, so it is
// dropped from the window unless the caller asked about today by name.
// See the comparison against the leading miner in fetchForecast's comment.


const at = (iso) => new Date(iso).getTime();

test('weather: today counts as spent late in the local evening', () => {
  // Makurdi is UTC+1, so 22:00Z is 23:00 local, the case measured live.
  assert.equal(isSpentToday('2026-08-30', 3600, at('2026-08-30T22:00:00Z')), true);
  assert.equal(isSpentToday('2026-08-30', 3600, at('2026-08-30T17:00:00Z')), true);
});

test('weather: today is kept while there is still day left', () => {
  assert.equal(isSpentToday('2026-08-30', 3600, at('2026-08-30T11:00:00Z')), false);
  assert.equal(isSpentToday('2026-08-30', 3600, at('2026-08-30T16:59:00Z')), false);
});

test('weather: the local hour is read at the place, not on this server', () => {
  // Miami is UTC-4: 01:00Z the next day is still 21:00 the evening before.
  assert.equal(isSpentToday('2026-08-30', -14400, at('2026-08-31T01:00:00Z')), true);
  // Tokyo is UTC+9 and its forecast already starts on a later date, so
  // there is no spent day to drop.
  assert.equal(isSpentToday('2026-08-29', 32400, at('2026-08-30T14:00:00Z')), false);
});

test('weather: an unknown timezone offset never drops a day', () => {
  // Guessing would silently skip a day the caller asked for.
  assert.equal(isSpentToday('2026-08-30', undefined, at('2026-08-30T22:00:00Z')), false);
  assert.equal(isSpentToday(null, 3600, at('2026-08-30T22:00:00Z')), false);
});
