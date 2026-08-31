import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchOwmDaily, fetchOwmHourly, isOwmConfigured } from './owmFallback.js';
import { fetchForecast, fetchStormRisk, isTruncatedFirstDay, __clearWeatherCachesForTesting } from './weatherForecast.js';

const LONDON = {
  name: 'London', latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London',
};

// A trimmed copy of the shape api.openweathermap.org/data/2.5/forecast
// actually returns, captured live 2026-08-31: 3-hourly rows, wind in metres
// per second with a real `gust`, and `pop` as a 0-1 probability. `slots`
// lets a test build a day out of however many 3-hour rows it needs, which is
// how a truncated "today" is reproduced.
function owmFixture(startIso = '2026-08-31T00:00:00Z', slots = 8) {
  const list = [];
  for (let i = 0; i < slots; i += 1) {
    list.push({
      dt: Math.floor((Date.parse(startIso) + i * 3 * 3_600_000) / 1000),
      main: { temp: 10 + i, temp_min: 8 + i, temp_max: 12 + i },
      weather: [{ id: i === 2 ? 500 : 804 }],
      wind: { speed: 5 + i, deg: 90, gust: 9 + i },
      pop: i === 2 ? 0.62 : 0.1,
      rain: i === 2 ? { '3h': 2 } : undefined,
    });
  }
  return { city: { timezone: 0 }, list };
}

function stubOwm(t, body, { status = 200 } = {}) {
  const realFetch = global.fetch;
  const calls = { owm: 0 };
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.openweathermap.org')) {
      calls.owm += 1;
      if (status !== 200) return new Response('nope', { status });
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; });
  return calls;
}

function withKey(t, value = 'test-owm-key') {
  const previous = process.env.OPENWEATHERMAP_API_KEY;
  if (value == null) delete process.env.OPENWEATHERMAP_API_KEY;
  else process.env.OPENWEATHERMAP_API_KEY = value;
  t.after(() => {
    if (previous == null) delete process.env.OPENWEATHERMAP_API_KEY;
    else process.env.OPENWEATHERMAP_API_KEY = previous;
  });
}

test('owm: the tier is skipped entirely unless a key is configured', (t) => {
  withKey(t, null);
  assert.equal(isOwmConfigured(), false);
  process.env.OPENWEATHERMAP_API_KEY = 'k';
  assert.equal(isOwmConfigured(), true);
});

test('owm: the precipitation probability MET Norway cannot supply survives the reshape', async (t) => {
  withKey(t);
  stubOwm(t, owmFixture());
  const { daily } = await fetchOwmDaily(LONDON);
  // The whole reason this provider sits ahead of MET Norway: a real number
  // here, not a null, so the graded answer keeps its "chance of
  // precipitation peaking at X%" clause.
  assert.equal(daily.precipitation_probability_max[0], 62);
});

test('owm: condition ids collapse onto the WMO codes the rest of the app expects', async (t) => {
  withKey(t);
  const cases = [[200, 95], [301, 51], [511, 66], [502, 63], [521, 80], [601, 73], [741, 45], [800, 0], [801, 1], [802, 2], [804, 3], [null, 3]];
  for (const [id, wmo] of cases) {
    const body = owmFixture('2026-08-31T00:00:00Z', 1);
    body.list[0].weather = id == null ? [] : [{ id }];
    stubOwm(t, body);
    const { daily } = await fetchOwmDaily(LONDON);
    assert.equal(daily.weathercode[0], wmo, `owm id ${id}`);
  }
});

test('owm: wind is converted to km/h and gusts are measured, not estimated', async (t) => {
  withKey(t);
  stubOwm(t, owmFixture('2026-08-31T00:00:00Z', 1));
  const { daily } = await fetchOwmDaily(LONDON);
  // 5 m/s * 3.6 = 18 km/h, 9 m/s * 3.6 = 32.4 km/h. Unlike MET Norway,
  // OWM publishes a real gust, so this is not a 1.5x estimate.
  assert.equal(daily.windspeed_10m_max[0], 18);
  assert.equal(daily.windgusts_10m_max[0], 32.4);
  assert.equal(daily.winddirection_10m_dominant[0], 90);
});

test('owm: slots are bucketed into local calendar days, not UTC days', async (t) => {
  withKey(t);
  // Tokyo is +9, so 00:00Z on the 31st is already 09:00 on the 31st there,
  // and the later slots have rolled over into the 1st.
  const body = owmFixture('2026-08-31T00:00:00Z', 8);
  body.city.timezone = 9 * 3600;
  stubOwm(t, body);
  const { daily, utc_offset_seconds } = await fetchOwmDaily({ ...LONDON, timezone: 'Asia/Tokyo' });
  assert.equal(utc_offset_seconds, 9 * 3600);
  assert.deepEqual(daily.time, ['2026-08-31', '2026-09-01']);
});

test('owm: a slot carrying both rain and snow is three hours of precipitation, not six', async (t) => {
  withKey(t);
  const body = owmFixture('2026-08-31T00:00:00Z', 2);
  body.list[0].rain = { '3h': 1 };
  body.list[0].snow = { '3h': 2 };
  body.list[1].rain = undefined;
  body.list[1].snow = undefined;
  stubOwm(t, body);
  const { daily } = await fetchOwmDaily(LONDON);
  assert.equal(daily.precipitation_hours[0], 3);
  assert.equal(daily.precipitation_sum[0], 3);
  assert.equal(daily.snowfall_sum[0], 2);
});

test('owm: a remnant of a day is reported as one, so it is not served as today', async (t) => {
  withKey(t);
  // Late evening: OWM's list starts at the next slot ahead, so today is a
  // single 3-hour row whose high and low come from one reading.
  stubOwm(t, owmFixture('2026-08-31T21:00:00Z', 1));
  const { daily } = await fetchOwmDaily(LONDON);
  assert.equal(daily.hours_counted[0], 3);
  assert.equal(isTruncatedFirstDay(daily.hours_counted[0]), true);
});

test('owm: a full day of slots is a real day and must not be dropped', async (t) => {
  withKey(t);
  stubOwm(t, owmFixture('2026-08-31T00:00:00Z', 8));
  const { daily } = await fetchOwmDaily(LONDON);
  assert.equal(daily.hours_counted[0], 24);
  assert.equal(isTruncatedFirstDay(daily.hours_counted[0]), false);
});

test('owm: an upstream error status is raised rather than answered from a partial body', async (t) => {
  withKey(t);
  stubOwm(t, {}, { status: 401 });
  await assert.rejects(() => fetchOwmDaily(LONDON), /status 401/);
});

// The point of the tier: when Open-Meteo fails, the daily answer comes from
// a source that still has a precipitation probability, instead of dropping
// straight to MET Norway where that figure is always null outside the
// Nordics. The geocoder is left working, as in metnoFallback.test.js,
// because it is a different host.
function stubOpenMeteoDown(t, { owmStatus = 200 } = {}) {
  const realFetch = global.fetch;
  const calls = { owm: 0, metno: 0 };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.open-meteo.com')) return new Response('rate limited', { status: 429 });
    if (u.startsWith('https://geocoding-api.open-meteo.com')) {
      return new Response(JSON.stringify({
        results: [{
          name: 'London', admin1: 'England', country: 'United Kingdom',
          latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.openweathermap.org')) {
      calls.owm += 1;
      if (owmStatus !== 200) return new Response('nope', { status: owmStatus });
      const start = new Date(Date.now() - 6 * 3_600_000).toISOString();
      return new Response(JSON.stringify(owmFixture(start, 40)), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (u.startsWith('https://api.met.no')) {
      calls.metno += 1;
      return new Response('nope', { status: 503 });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; });
  return calls;
}

test('weather-forecast reaches OpenWeatherMap before MET Norway when a key is set', async (t) => {
  __clearWeatherCachesForTesting();
  withKey(t);
  const calls = stubOpenMeteoDown(t);
  const out = await fetchForecast('London', 2);
  assert.equal(calls.owm, 1);
  assert.equal(calls.metno, 0);
  assert.equal(out.source, 'OpenWeatherMap');
  assert.equal(out.degraded, true);
  assert.equal(out.attribution, 'https://openweathermap.org');
  assert.equal(typeof out.days[0].precipitation_probability_pct, 'number');
});

test('weather-forecast skips the OpenWeatherMap tier entirely when no key is set', async (t) => {
  __clearWeatherCachesForTesting();
  withKey(t, null);
  const calls = stubOpenMeteoDown(t);
  await assert.rejects(() => fetchForecast('London', 2));
  assert.equal(calls.owm, 0);
  assert.equal(calls.metno, 1);
});

test('a failing OpenWeatherMap call still falls through to MET Norway', async (t) => {
  __clearWeatherCachesForTesting();
  withKey(t);
  const calls = stubOpenMeteoDown(t, { owmStatus: 401 });
  await assert.rejects(() => fetchForecast('London', 2));
  assert.equal(calls.owm, 1);
  assert.equal(calls.metno, 1);
});

test('owm hourly: each 3-hour slot becomes three rows, so the storm window slices by hour', async (t) => {
  withKey(t);
  stubOwm(t, owmFixture('2026-08-31T00:00:00Z', 4));
  const { hourly } = await fetchOwmHourly(LONDON);
  assert.equal(hourly.time.length, 12);
  assert.deepEqual(hourly.time.slice(0, 4), [
    '2026-08-31T00:00', '2026-08-31T01:00', '2026-08-31T02:00', '2026-08-31T03:00',
  ]);
  // Every field stays the same length, or the index-based slice desynchronises.
  for (const series of Object.values(hourly)) assert.equal(series.length, 12);
});

test('owm hourly: the reported peak gust is preserved, not smoothed away', async (t) => {
  withKey(t);
  stubOwm(t, owmFixture('2026-08-31T00:00:00Z', 2));
  const { hourly } = await fetchOwmHourly(LONDON);
  // Slot 0 is 5 m/s sustained with a 9 m/s gust, repeated across its three
  // hours: 18 and 32.4 km/h. Interpolating would round the peak down and
  // understate the risk grade.
  assert.deepEqual(hourly.windspeed_10m.slice(0, 3), [18, 18, 18]);
  assert.deepEqual(hourly.windgusts_10m.slice(0, 3), [32.4, 32.4, 32.4]);
  assert.deepEqual(hourly.winddirection_10m.slice(0, 3), [90, 90, 90]);
});

test('owm hourly: a slot total of rain is spread across its three hours, not repeated', async (t) => {
  withKey(t);
  const body = owmFixture('2026-08-31T00:00:00Z', 3);
  stubOwm(t, body);
  const { hourly } = await fetchOwmHourly(LONDON);
  // Slot 2 carries 2mm over three hours. Repeating it would report 2mm in
  // every one of those hours and treble the peak hourly rainfall.
  assert.deepEqual(hourly.precipitation.slice(6, 9), [0.7, 0.7, 0.7]);
  assert.deepEqual(hourly.precipitation.slice(0, 3), [0, 0, 0]);
  // Slot 2 is condition id 500, light rain, which maps to WMO 63.
  assert.deepEqual(hourly.weathercode.slice(6, 9), [63, 63, 63]);
});

test('owm hourly: timestamps are shifted into local time the storm window compares against', async (t) => {
  withKey(t);
  const body = owmFixture('2026-08-31T00:00:00Z', 1);
  body.city.timezone = 9 * 3600;
  stubOwm(t, body);
  const { hourly, utc_offset_seconds } = await fetchOwmHourly({ ...LONDON, timezone: 'Asia/Tokyo' });
  assert.equal(utc_offset_seconds, 9 * 3600);
  assert.equal(hourly.time[0], '2026-08-31T09:00');
});

test('storm-alert reaches OpenWeatherMap before MET Norway and reports a measured gust', async (t) => {
  __clearWeatherCachesForTesting();
  withKey(t);
  const calls = stubOpenMeteoDown(t);
  const out = await fetchStormRisk('London', 24);
  assert.equal(calls.owm, 1);
  assert.equal(calls.metno, 0);
  assert.equal(out.source, 'OpenWeatherMap');
  assert.equal(out.degraded, true);
  // The reason this tier is worth having on the storm route: unlike MET
  // Norway, OWM publishes a real gust, so the grade must not be labelled an
  // estimate here.
  assert.equal(out.gusts_estimated, undefined);
  assert.equal(typeof out.peak_gust_kmh, 'number');
});

test('storm-alert falling all the way to MET Norway still says its gusts are estimated', async (t) => {
  __clearWeatherCachesForTesting();
  withKey(t, null);
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.open-meteo.com')) return new Response('rate limited', { status: 429 });
    if (u.startsWith('https://geocoding-api.open-meteo.com')) {
      return new Response(JSON.stringify({
        results: [{
          name: 'London', admin1: 'England', country: 'United Kingdom',
          latitude: 51.5074, longitude: -0.1278, timezone: 'Europe/London',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://api.met.no')) {
      const timeseries = [];
      for (let i = 0; i < 48; i += 1) {
        timeseries.push({
          time: new Date(Date.now() + i * 3_600_000).toISOString(),
          data: {
            instant: { details: { air_temperature: 10, wind_speed: 6, wind_from_direction: 90 } },
            next_1_hours: { summary: { symbol_code: 'partlycloudy_day' }, details: { precipitation_amount: 0 } },
          },
        });
      }
      return new Response(JSON.stringify({ properties: { timeseries } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };
  t.after(() => { global.fetch = realFetch; });
  const out = await fetchStormRisk('London', 24);
  assert.equal(out.source, 'MET Norway');
  assert.equal(out.gusts_estimated, true);
});
