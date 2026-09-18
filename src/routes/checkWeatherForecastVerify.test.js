import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkWeatherForecastVerify.js';
import { __clearWeatherCachesForTesting } from '../lib/weatherForecast.js';

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/weather-forecast-verify', forwardAsyncErrors(router));
  app.use(errorHandler);
  return app;
}

function startServer(t) {
  const server = buildTestApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

const GEOCODE_LONDON = {
  results: [{ name: 'London', admin1: 'England', country: 'United Kingdom', latitude: 51.5, longitude: -0.11, timezone: 'Europe/London' }],
};

const ARCHIVE_BODY = {
  timezone: 'Europe/London',
  daily: {
    time: ['2026-08-01'],
    temperature_2m_max: [24.5],
    temperature_2m_min: [15.2],
    precipitation_sum: [0.4],
    weathercode: [1],
    windspeed_10m_max: [14.2],
  },
};

function stubWeather(t, { geocode = GEOCODE_LONDON, archive = ARCHIVE_BODY } = {}) {
  __clearWeatherCachesForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://geocoding-api.open-meteo.com')) {
      return new Response(JSON.stringify(geocode), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (str.startsWith('https://archive-api.open-meteo.com')) {
      const status = archive && typeof archive === 'object' && 'status' in archive && 'body' in archive ? archive.status : 200;
      const body = archive && typeof archive === 'object' && 'status' in archive && 'body' in archive ? archive.body : archive;
      return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearWeatherCachesForTesting(); });
}

test('WEATHER_FORECAST_VERIFY happy path reports actual past conditions', async (t) => {
  const base = startServer(t);
  stubWeather(t);
  const res = await fetch(`${base}/weather-forecast-verify?location=London&date=2026-08-01`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.temp_max_c, 24.5);
  assert.match(json.summary, /not a forecast/);
});

test('WEATHER_FORECAST_VERIFY missing location refuses with 200, not 4xx', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast-verify?date=2026-08-01`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('WEATHER_FORECAST_VERIFY missing date refuses honestly', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast-verify?location=London`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

// Real routed question seen live: a forward-looking forecast question
// misrouted to this verify intent. Today or future dates must be refused
// honestly, not fabricated.
test('WEATHER_FORECAST_VERIFY refuses a today/future date, does not fabricate a forecast', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast-verify?${new URLSearchParams({ query: 'What is the 24-hour weather forecast for Auckland starting today?', location: 'Auckland' })}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
  assert.match(json.summary, /not a forecast|future/i);
});

test('WEATHER_FORECAST_VERIFY free-text question extracts location and date', async (t) => {
  const base = startServer(t);
  stubWeather(t);
  const res = await fetch(`${base}/weather-forecast-verify?question=${encodeURIComponent('What was the weather in London on 2026-08-01?')}&location=London`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
});

test('WEATHER_FORECAST_VERIFY nonexistent place refuses honestly', async (t) => {
  const base = startServer(t);
  stubWeather(t, { geocode: { results: [] } });
  const res = await fetch(`${base}/weather-forecast-verify?location=Zzzzznotaplace&date=2026-08-01`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('WEATHER_FORECAST_VERIFY handles a 12,000+ char input without crashing', async (t) => {
  const base = startServer(t);
  const long = 'a'.repeat(12_500);
  const res = await fetch(`${base}/weather-forecast-verify?location=${encodeURIComponent(long)}&date=2026-08-01`);
  assert.equal(res.status, 200);
});

test('WEATHER_FORECAST_VERIFY upstream failure returns a real error code', async (t) => {
  const base = startServer(t);
  stubWeather(t, { archive: { status: 500, body: {} } });
  const res = await fetch(`${base}/weather-forecast-verify?location=London&date=2026-08-01`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.status, 'error');
});

test('WEATHER_FORECAST_VERIFY POST works the same as GET', async (t) => {
  const base = startServer(t);
  stubWeather(t);
  const res = await fetch(`${base}/weather-forecast-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'London', date: '2026-08-01' }),
  });
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

// Real routed question shape (2026-09-18 replay): a whole question with
// the date embedded in it arrived entirely in the location field, with no
// separate date param at all, and this was refused because the date
// extraction fallback only checked a dedicated free-text field, never the
// structured location field that had actually received the whole sentence.
test('WEATHER_FORECAST_VERIFY a date embedded in the location field alone is found', async (t) => {
  const base = startServer(t);
  stubWeather(t);
  const res = await fetch(`${base}/weather-forecast-verify?location=${encodeURIComponent('What was the actual weather in London on 2026-08-01?')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.date, '2026-08-01');
});
