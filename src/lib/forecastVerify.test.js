import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetDate, ghcnStation, placeIn, readClaims, readTolerance, verdictAnswer, coordsIn,
} from './forecastVerify.js';

test('target date is the latest one named, also when written in words', () => {
  assert.equal(targetDate('the forecast maximum temperature for 24 September 2026, issued at 00:00 UTC on 23 September 2026'), '2026-09-24');
  assert.equal(targetDate('On 2025-12-02 the model forecast for Singapore the next day (2025-12-03)'), '2025-12-03');
  assert.equal(targetDate('How hot did it get in Sacramento on August 16, 2025?'), '2025-08-16');
});

test('reads place, station, forecast values, references and tolerance', () => {
  const q = 'Check 2025-01-03 at PORTLAND INTL AP (KPDX, GHCN USW00024229) against the actual daily high: the GFS MOS run initialized 2025-01-01 00:00 UTC predicted a daytime maximum of 45 degrees Fahrenheit for 2025-01-03.';
  assert.equal(ghcnStation(q), 'USW00024229');
  assert.equal(placeIn(q), 'PORTLAND INTL AP');
  const c = readClaims(q);
  assert.ok(Math.abs(c.forecast.max - 7.22) < 0.01);
  assert.equal(c.fahrenheit, true);

  const s = 'On 2025-12-02 the model forecast for Singapore the next day (2025-12-03) was a high of 30.0 °C and an overnight low of 22.5 °C. For reference, ERA5 reanalysis from the Open-Meteo archive gives max temperature 33.1 °C; min temperature 21.9 °C for that day. Rule: a temperature holds within 2.0 °C.';
  const sc = readClaims(s);
  assert.deepEqual(sc.forecast, { max: 30, min: 22.5 });
  assert.deepEqual(sc.reference, { max: 33.1, min: 21.9 });
  assert.equal(placeIn(s), 'Singapore');

  const h = 'verify the forecast issued at 00:00 UTC on 4 September 2026: 0.27 in precipitation on September 5, 2026. Tolerance: 25% of the forecast or 1 mm, whichever is larger.';
  assert.ok(Math.abs(readClaims(h).forecast.precip - 6.858) < 0.001);
  assert.deepEqual(readTolerance(h).precip, { rule: 'pct', pct: 0.25, floor: 1 });
  assert.equal(coordsIn('weather at 51.5085,-0.1257 on 2026-11-19'), '51.5085,-0.1257');
});

test('verdict leads the answer: verified, partly verified, not verified', () => {
  const tol = { temp: 2, precip: { rule: 'wetdry' } };
  const obs = { max: 29.8, min: 24.9, precip: 2.1, source: 'test' };
  const no = verdictAnswer({ placeName: 'Phoenix', date: '2026-09-24', claims: { forecast: { max: 34.5 }, reference: {} }, tolerance: tol, observed: obs });
  assert.match(no.answer, /^Not verified\. .*29\.8 °C against the forecast 34\.5 °C, an error of -4\.7 °C, outside/);
  const part = verdictAnswer({ placeName: 'X', date: '2026-09-24', claims: { forecast: { max: 30, min: 22.5 }, reference: { max: 33.1, min: 21.9 } }, tolerance: tol, observed: null });
  assert.match(part.answer, /^Partly verified\./);
  const yes = verdictAnswer({ placeName: 'X', date: '2026-09-24', claims: { forecast: { precip: 2.9 }, reference: { precip: 2 } }, tolerance: tol, observed: null });
  assert.match(yes.answer, /^Verified\./);
});
