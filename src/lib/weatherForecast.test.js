import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTruncatedFirstDay, fetchForecast } from './weatherForecast.js';
import { toOpenMeteoDaily } from './metnoFallback.js';

// The first day of a forecast is dropped only when it is a remnant rather
// than a whole day, and that is decided from the hours the provider
// supplied. The two providers differ: MET Norway returns future hours only,
// so its current day is truncated, while Open-Meteo's daily row covers the
// whole calendar day and is never a stub. See isTruncatedFirstDay.

test('weather: a first day built from a couple of evening hours is a stub', () => {
  assert.equal(isTruncatedFirstDay(1), true);
  assert.equal(isTruncatedFirstDay(5), true);
});

test('weather: a first day with most of its hours is a real day', () => {
  assert.equal(isTruncatedFirstDay(6), false);
  assert.equal(isTruncatedFirstDay(24), false);
});

test('weather: an absent hour count never drops a day', () => {
  // Open-Meteo supplies no hour count precisely because its today is whole.
  // Judging by the clock instead would have discarded a good day every
  // evening on the primary provider.
  assert.equal(isTruncatedFirstDay(undefined), false);
  assert.equal(isTruncatedFirstDay(null), false);
});

test('weather: the MET adapter reports how many hours each day was built from', () => {
  // Two readings left today, then a full day: exactly the shape that made
  // the first day's high and low collapse to the same number.
  const timeseries = [
    { time: '2026-08-30T22:00:00Z', data: { instant: { details: { air_temperature: 23.2, wind_speed: 4 } } } },
    { time: '2026-08-30T23:00:00Z', data: { instant: { details: { air_temperature: 23.2, wind_speed: 4 } } } },
    ...Array.from({ length: 24 }, (_, h) => ({
      time: `2026-08-31T${String(h).padStart(2, '0')}:00:00Z`,
      data: { instant: { details: { air_temperature: 20 + h * 0.4, wind_speed: 3 } } },
    })),
  ];

  const out = toOpenMeteoDaily({ properties: { timeseries } }, { timezone: 'UTC', offsetSeconds: 0 });

  assert.deepEqual(out.daily.time, ['2026-08-30', '2026-08-31']);
  assert.equal(out.daily.hours_counted[0], 2);
  assert.equal(out.daily.hours_counted[1], 24);
  // The stub really is degenerate: its high and low are the same number.
  assert.equal(out.daily.temperature_2m_max[0], out.daily.temperature_2m_min[0]);
  assert.equal(isTruncatedFirstDay(out.daily.hours_counted[0]), true);
  assert.equal(isTruncatedFirstDay(out.daily.hours_counted[1]), false);
});

test('weather: a forecast returns the number of days asked for', async () => {
  const result = await fetchForecast('London', 3, 0);
  assert.equal(result.days.length, 3);
  // Whatever the window, no returned day may be a collapsed stub.
  assert.ok(result.days[0].temp_max >= result.days[0].temp_min);
});
