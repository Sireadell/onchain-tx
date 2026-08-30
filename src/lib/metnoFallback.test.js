import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METNO_USER_AGENT, wmoFromSymbol, offsetSecondsForTimezone,
  toOpenMeteoDaily, toOpenMeteoHourly,
} from './metnoFallback.js';
import { fetchForecast, fetchStormRisk, __clearWeatherCachesForTesting } from './weatherForecast.js';

// A trimmed copy of a real api.met.no/locationforecast/2.0/compact response,
// captured live 2026-08-30. Kept in the shape MET actually returns, including
// the switch from hourly to 6-hourly entries partway through, because that
// switch is the thing most likely to break the hour-indexed storm window.
function metnoFixture(startIso = '2026-08-30T00:00:00Z', hours = 12) {
  const timeseries = [];
  for (let i = 0; i < hours; i += 1) {
    timeseries.push({
      time: new Date(Date.parse(startIso) + i * 3_600_000).toISOString(),
      data: {
        instant: {
          details: {
            air_temperature: 10 + i,
            wind_speed: 5 + i * 0.5, // m/s
            wind_from_direction: 90,
          },
        },
        next_1_hours: {
          summary: { symbol_code: i === 3 ? 'rainandthunder_day' : 'partlycloudy_day' },
          details: { precipitation_amount: i === 3 ? 2 : 0 },
        },
      },
    });
  }
  return { properties: { timeseries } };
}

test('metno: symbol codes map onto the WMO codes the rest of the app expects', () => {
  assert.equal(wmoFromSymbol('clearsky_day'), 0);
  assert.equal(wmoFromSymbol('fair_night'), 1);
  assert.equal(wmoFromSymbol('partlycloudy_polartwilight'), 2);
  assert.equal(wmoFromSymbol('heavyrain'), 65);
  // Thunderstorms must land on 95/96: storm risk keys off exactly these.
  assert.equal(wmoFromSymbol('rainandthunder'), 95);
  assert.equal(wmoFromSymbol('heavyrainandthunder_day'), 96);
  // An unrecognised or missing code must not crash or masquerade as clear sky.
  assert.equal(wmoFromSymbol('somethingnew_day'), 3);
  assert.equal(wmoFromSymbol(null), 3);
});

test('metno: timezone offsets are read from the IANA zone, and unknown zones fall back to UTC', () => {
  // Fixed instants, so this does not drift with daylight saving.
  const july = new Date('2026-07-01T12:00:00Z');
  assert.equal(offsetSecondsForTimezone('Asia/Tokyo', july), 9 * 3600);
  assert.equal(offsetSecondsForTimezone('America/New_York', july), -4 * 3600);
  assert.equal(offsetSecondsForTimezone('UTC', july), 0);
  assert.equal(offsetSecondsForTimezone(null), 0);
  assert.equal(offsetSecondsForTimezone('Not/AZone'), 0);
});

test('metno: wind is converted from metres per second to km/h', () => {
  const { hourly } = toOpenMeteoHourly(metnoFixture(), {});
  // 5 m/s * 3.6 = 18 km/h
  assert.equal(hourly.windspeed_10m[0], 18);
  // Gusts are estimated at 1.5x sustained, since MET publishes none outside
  // its own region. Documented as an estimate on the response.
  assert.equal(hourly.windgusts_10m[0], 27);
});

test('metno: the hourly series stays one entry per hour so the storm window slices correctly', () => {
  const { hourly } = toOpenMeteoHourly(metnoFixture('2026-08-30T00:00:00Z', 12), {});
  assert.equal(hourly.time.length, 12);
  assert.equal(hourly.windspeed_10m.length, 12);
  assert.equal(hourly.weathercode.length, 12);
  // The thunderstorm hour survives the conversion at the right index.
  assert.equal(hourly.weathercode[3], 95);
  assert.equal(hourly.precipitation[3], 2);
});

test('metno: daily buckets use local calendar days, not UTC days', () => {
  // 12 hours from 00:00 UTC, viewed from Tokyo (+9), all land on Aug 30 local
  // except the first nine hours, which are still Aug 30 in Tokyo terms.
  const daily = toOpenMeteoDaily(metnoFixture('2026-08-30T00:00:00Z', 12), {
    timezone: 'Asia/Tokyo', offsetSeconds: 9 * 3600,
  }).daily;
  // 00:00Z is 09:00 local on the 30th; 12:00Z is 21:00 local the same day.
  assert.deepEqual(daily.time, ['2026-08-30']);
  assert.equal(daily.temperature_2m_min[0], 10);
  assert.equal(daily.temperature_2m_max[0], 21);
  // The most significant condition of the day wins, not the most common.
  assert.equal(daily.weathercode[0], 95);
  assert.equal(daily.precipitation_sum[0], 2);
  assert.equal(daily.precipitation_hours[0], 1);
  // Fields MET does not publish come back null rather than invented.
  assert.equal(daily.precipitation_probability_max[0], null);
  assert.equal(daily.snowfall_sum[0], null);
});

// The point of the whole exercise: when Open-Meteo rate-limits Render's
// shared egress IP, the answer still gets served. The geocoder is left
// working here on purpose, because it is a different host and it is the
// forecast call that was observed failing live.
function stubOpenMeteoRateLimited(t, { metnoStatus = 200 } = {}) {
  const realFetch = global.fetch;
  const calls = { metno: 0, metnoHeaders: null };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.open-meteo.com')) {
      return new Response('rate limited', { status: 429 });
    }
    if (u.startsWith('https://geocoding-api.open-meteo.com')) {
      return new Response(JSON.stringify({
        results: [{
          name: 'London', admin1: 'England', country: 'United Kingdom',
          latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.met.no')) {
      calls.metno += 1;
      calls.metnoHeaders = opts?.headers ?? null;
      if (metnoStatus !== 200) return new Response('nope', { status: metnoStatus });
      return new Response(JSON.stringify(metnoFixture('2026-08-30T00:00:00Z', 72)), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; });
  return calls;
}

test('weather-forecast still answers when Open-Meteo rate-limits the shared IP', async (t) => {
  __clearWeatherCachesForTesting();
  const calls = stubOpenMeteoRateLimited(t);

  const result = await fetchForecast('London', 2, 0);

  assert.equal(calls.metno, 1, 'MET Norway should have been asked exactly once');
  assert.match(result.source, /MET Norway/);
  assert.equal(result.degraded, true);
  assert.ok(result.days.length > 0, 'the fallback must return real forecast days');
  assert.equal(typeof result.days[0].temp_max, 'number');
});

test('storm-alert still answers when Open-Meteo rate-limits the shared IP', async (t) => {
  __clearWeatherCachesForTesting();
  stubOpenMeteoRateLimited(t);

  const result = await fetchStormRisk('London', 48);

  assert.match(result.source, /MET Norway/);
  assert.equal(result.degraded, true);
  // Gusts are estimated on this path and the response must say so, rather
  // than presenting an estimate as a measurement.
  assert.equal(result.gusts_estimated, true);
  assert.ok(['LOW', 'MODERATE', 'HIGH', 'SEVERE'].includes(result.risk));
  assert.equal(typeof result.risk_score, 'number');
});

test('the MET Norway call sends the identifying User-Agent its terms require', async (t) => {
  __clearWeatherCachesForTesting();
  const calls = stubOpenMeteoRateLimited(t);

  await fetchForecast('London', 1, 0);

  // MET throttles unidentified clients to 429, which would defeat the
  // entire point of having a fallback.
  assert.equal(calls.metnoHeaders?.['User-Agent'], METNO_USER_AGENT);
  assert.ok(/github\.com/.test(METNO_USER_AGENT), 'the UA must identify the application');
});

test('when both providers fail, the caller is told it is an upstream problem', async (t) => {
  __clearWeatherCachesForTesting();
  stubOpenMeteoRateLimited(t, { metnoStatus: 503 });

  await assert.rejects(
    () => fetchForecast('London', 1, 0),
    (err) => {
      assert.equal(err.name, 'WeatherUpstreamError');
      // The original Open-Meteo failure leads, since that is the path that
      // normally serves, with the fallback failure appended for diagnosis.
      assert.match(err.message, /429/);
      assert.match(err.message, /fallback also failed/);
      return true;
    },
  );
});
