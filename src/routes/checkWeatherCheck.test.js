import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import {
  __clearWeatherCachesForTesting, currentPlaceCandidates, rankGeocodeResults,
} from '../lib/weatherForecast.js';

// The stubbed tests below replace fetch for the geocoder and forecast so
// the place-choice logic is exercised deterministically. The last test
// hits the real live API, same trade-off as checkWeatherForecast.test.js.

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

const GEO = {
  houston: [
    { name: 'Houston', admin1: 'Texas', country: 'United States', country_code: 'US', feature_code: 'PPLA2', population: 2314157, latitude: 29.76, longitude: -95.36, timezone: 'America/Chicago' },
    { name: 'Houston', admin1: 'Missouri', country: 'United States', country_code: 'US', feature_code: 'PPLA2', population: 2082, latitude: 37.32, longitude: -91.95, timezone: 'America/Chicago' },
  ],
  alaska: [
    { name: 'Akaska', admin1: 'South Dakota', country: 'United States', feature_code: 'PPL', population: 43, latitude: 45.33, longitude: -100.12 },
  ],
  anchorage: [
    { name: 'Anchorage', admin1: 'Alaska', country: 'United States', country_code: 'US', feature_code: 'PPLA2', population: 291247, latitude: 61.21, longitude: -149.9, timezone: 'America/Anchorage' },
  ],
  china: [
    { name: 'China', country: 'China', feature_code: 'PCLI', population: 1411778724, latitude: 35, longitude: 105 },
    { name: 'China', admin1: 'Nuevo León', country: 'Mexico', feature_code: 'PPLA2', population: 8997, latitude: 25.69, longitude: -99.23 },
  ],
  beijing: [
    { name: 'Beijing', admin1: 'Beijing', country: 'China', country_code: 'CN', feature_code: 'PPLC', population: 18960744, latitude: 39.9, longitude: 116.39, timezone: 'Asia/Shanghai' },
  ],
  wind: [
    { name: 'Windhoek', admin1: 'Khomas', country: 'Namibia', feature_code: 'PPLC', population: 268132, latitude: -22.55, longitude: 17.08 },
  ],
  darwin: [
    { name: 'Darwin', admin1: 'Northern Territory', country: 'Australia', country_code: 'AU', feature_code: 'PPLA', population: 139902, latitude: -12.46, longitude: 130.84, timezone: 'Australia/Darwin' },
    { name: 'Darwin', admin1: 'Minnesota', country: 'United States', feature_code: 'PPL', population: 352, latitude: 45.09, longitude: -94.41 },
  ],
  lagos: [
    { name: 'Lagos', admin1: 'Lagos', country: 'Nigeria', country_code: 'NG', feature_code: 'PPLA2', population: 15388000, latitude: 6.45, longitude: 3.39, timezone: 'Africa/Lagos' },
    { name: 'Lagos', admin1: 'Faro District', country: 'Portugal', country_code: 'PT', feature_code: 'PPL', population: 33494, latitude: 37.1, longitude: -8.67 },
  ],
  tokyo: [
    { name: 'Tokyo', admin1: 'Tokyo', country: 'Japan', country_code: 'JP', feature_code: 'PPLC', population: 8336599, latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' },
  ],
};

function stubWeather(t, { geo = GEO, current = {} } = {}) {
  __clearWeatherCachesForTesting();
  const original = globalThis.fetch;
  const calls = { geocode: [], forecast: [] };
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://geocoding-api.open-meteo.com')) {
      const name = decodeURIComponent(new URL(str).searchParams.get('name')).toLowerCase();
      calls.geocode.push(name);
      return new Response(JSON.stringify({ results: geo[name] ?? [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (str.startsWith('https://api.open-meteo.com/v1/forecast')) {
      calls.forecast.push(str);
      return new Response(JSON.stringify({
        timezone: 'Asia/Bangkok',
        utc_offset_seconds: 25200,
        current: {
          time: '2026-09-17T06:15', temperature_2m: 25.6, relative_humidity_2m: 96, apparent_temperature: 31.5,
          precipitation: 0, weathercode: 3, wind_speed_10m: 5, wind_direction_10m: 225, cloud_cover: 96, ...current,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearWeatherCachesForTesting(); });
  return calls;
}

test('weather-check: currentPlaceCandidates reads the place out of real question shapes', () => {
  const names = (q) => currentPlaceCandidates(q).map((c) => `${c.name}${c.hint ? `|${c.hint}` : ''}`);
  assert.equal(names('Houston, Texas storm watch?')[0], 'Houston|Texas');
  assert.equal(names('Tell me if Houston, Texas has any active warnings for wind, flooding or storms.')[0], 'Houston|Texas');
  assert.equal(names("how's the weather in alaska")[0], 'alaska');
  assert.equal(names('Rather than a general forecast, I want to know specifically whether an official body has issued a storm or severe weather alert covering Darwin, Australia right now, and what it says.')[0], 'Darwin|Australia');
  assert.equal(names('Lagos Nigeria')[0], 'Lagos|Nigeria');
  assert.equal(names('Give me the temperature forecast for Cape Town right now.')[0], 'Cape Town');
  assert.equal(names('London, UK')[0], 'London|United Kingdom');
  assert.ok(!names("how's the weather in alaska").some((n) => n.startsWith("'s")), 'contraction tail leaked as a place');
});

test('weather-check: rankGeocodeResults never takes a fuzzy hit and honours the region hint', () => {
  assert.equal(rankGeocodeResults(GEO.alaska, 'alaska', null), null, 'Akaska accepted for alaska');
  assert.equal(rankGeocodeResults(GEO.wind, 'wind', null), null, 'Windhoek accepted for wind');
  assert.equal(rankGeocodeResults(GEO.houston, 'Houston', 'Texas').admin1, 'Texas');
  assert.equal(rankGeocodeResults(GEO.houston, 'Houston', 'Missouri').admin1, 'Missouri');
  assert.equal(rankGeocodeResults(GEO.houston, 'Houston', null).admin1, 'Texas', 'biggest Houston should win with no hint');
  assert.equal(rankGeocodeResults(GEO.lagos, 'Lagos', 'Nigeria').country, 'Nigeria');
  assert.equal(rankGeocodeResults(GEO.lagos, 'Lagos', 'Portugal').country, 'Portugal');
  assert.equal(rankGeocodeResults(GEO.darwin, 'Darwin', 'Australia').country, 'Australia');
});

test('weather-check: missing location answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-check`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('weather-check: unrecognized location answered with guidance, not a 500', async (t) => {
  stubWeather(t);
  const base = startServer(t);
  const res = await fetch(`${base}/weather-check?location=${encodeURIComponent('zzzznotarealplacexyz')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('weather-check: leads with place, temperature, condition and the time of reading', async (t) => {
  stubWeather(t);
  const base = startServer(t);
  const res = await fetch(`${base}/weather-check?location=Tokyo`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /^Right now in Tokyo, Japan it is 25\.6°C \(78\.1°F\) and overcast, feels like 31\.5°C\./);
  assert.match(body.summary, /Observed at 2026-09-17T06:15 local time \(2026-09-16 23:15:00 UTC\)/);
  assert.equal(body.temperature_f, 78.1);
  assert.equal(body.observed_at_utc, '2026-09-16T23:15:00Z');
  assert.equal(body.answer, body.summary);
});

test('weather-check: accepts city, place, q, query, question and lat/lon aliases', async (t) => {
  const calls = stubWeather(t);
  const base = startServer(t);
  for (const qs of ['city=Tokyo', 'place=Tokyo', 'q=Tokyo', 'query=Tokyo', 'name=Tokyo', `question=${encodeURIComponent('What is the current weather in Tokyo?')}`]) {
    const res = await fetch(`${base}/weather-check?${qs}`);
    const body = await res.json();
    assert.equal(body.status, 'ok', `${qs} was refused`);
    assert.equal(body.location, 'Tokyo, Japan');
  }
  for (const qs of ['lat=35.68&lon=139.69', 'latitude=35.68&longitude=139.69', 'lat=35.68&lng=139.69']) {
    const res = await fetch(`${base}/weather-check?${qs}`);
    const body = await res.json();
    assert.equal(body.status, 'ok', `${qs} was refused`);
    assert.equal(body.latitude, 35.68);
  }
  // Coordinates never geocode.
  assert.ok(!calls.geocode.some((n) => /35\.68/.test(n)));
});

test('weather-check: "Houston, Texas storm watch?" answers about Houston, Texas, with a severe-weather note', async (t) => {
  stubWeather(t);
  const base = startServer(t);
  const res = await fetch(`${base}/weather-check?location=${encodeURIComponent('Houston, Texas storm watch?')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.location, 'Houston, Texas, United States');
  assert.match(body.summary, /no severe weather right now/);
  assert.equal(body.severe_weather_now, false);
});

test('weather-check: a thunderstorm reading says so on an alert question', async (t) => {
  stubWeather(t, { current: { weathercode: 95, wind_speed_10m: 70 } });
  const base = startServer(t);
  const res = await fetch(`${base}/weather-check?location=${encodeURIComponent('Are there severe weather warnings in effect for Houston, Texas right now?')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.severe_weather_now, true);
  assert.match(body.summary, /severe weather right now: thunderstorm, gale-force wind of 70 km\/h/);
});

test('weather-check: "for wind, flooding or storms" does not become Windhoek', async (t) => {
  stubWeather(t);
  const base = startServer(t);
  const res = await fetch(`${base}/weather-check?location=${encodeURIComponent('Tell me if Houston, Texas has any active warnings for wind, flooding or storms.')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.location, 'Houston, Texas, United States');
});

test('weather-check: a US state or country answers at its main city, not a fuzzy hamlet or a centroid', async (t) => {
  stubWeather(t);
  const base = startServer(t);
  let body = await (await fetch(`${base}/weather-check?location=${encodeURIComponent("how's the weather in alaska")}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.location, 'Anchorage, Alaska, United States');
  assert.match(body.summary, /alaska is a region, so this reading is for its main city/);

  body = await (await fetch(`${base}/weather-check?location=${encodeURIComponent('What is the current weather in China')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.location, 'Beijing, China');
});

test('weather-check: "Lagos Nigeria" without a comma resolves to Lagos, Nigeria', async (t) => {
  stubWeather(t);
  const base = startServer(t);
  const body = await (await fetch(`${base}/weather-check?location=${encodeURIComponent('Lagos Nigeria')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.location, 'Lagos, Nigeria');
});

test('weather-check: a long alert question naming Darwin, Australia is answered about Darwin', async (t) => {
  stubWeather(t);
  const base = startServer(t);
  const q = 'Rather than a general forecast, I want to know specifically whether an official body has issued a storm or severe weather alert covering Darwin, Australia right now, and what it says.';
  const body = await (await fetch(`${base}/weather-check?location=${encodeURIComponent(q)}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.location, 'Darwin, Northern Territory, Australia');
});

test('weather-check: a fragment in location with the question alongside falls back to the question', async (t) => {
  stubWeather(t);
  const base = startServer(t);
  const body = await (await fetch(`${base}/weather-check?location=${encodeURIComponent('over the next')}&question=${encodeURIComponent('What is the weather in Tokyo right now?')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.location, 'Tokyo, Japan');
});

test('weather-check: a non-weather question is refused before any geocoding', async (t) => {
  const calls = stubWeather(t);
  const base = startServer(t);
  const body = await (await fetch(`${base}/weather-check?location=${encodeURIComponent('Will Infacort receive FDA approval?')}`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.equal(calls.geocode.length, 0);
});

test('weather-check: live place name returns a single current-conditions reading', async (t) => {
  __clearWeatherCachesForTesting();
  const base = startServer(t);
  const res = await fetch(`${base}/weather-check?location=Tokyo`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.status, 'ok');
  assert.ok(body.condition);
  assert.equal(typeof body.temperature_c, 'number');
  assert.equal(typeof body.humidity_pct, 'number');
  assert.equal(typeof body.wind_speed_kmh, 'number');
  assert.ok(body.observed_at);
  assert.equal(body.answer, body.summary);
});
