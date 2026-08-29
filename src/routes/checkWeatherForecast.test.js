import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';

// WEATHER_FORECAST hits a real forecast API (lib/weatherForecast.js) rather
// than a mockable one — same trade-off as checkSslVerification.test.js:
// slower and network-dependent, but the endpoint's entire job is "what
// does a live forecast say right now."

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('weather-forecast: missing location answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('weather-forecast: place name returns condition, temps, precipitation, wind', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast?location=Tokyo`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.ok(body.condition);
  assert.equal(typeof body.temp_min_c, 'number');
  assert.equal(typeof body.temp_max_c, 'number');
  assert.equal(typeof body.precipitation_total_mm, 'number');
  assert.equal(typeof body.peak_wind_kmh, 'number');
});

test('weather-forecast: "lat,lon" is accepted directly without geocoding', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast?location=${encodeURIComponent('35.6,139.6')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('weather-forecast: unrecognized location answered with guidance, not a 500', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast?location=${encodeURIComponent('zzzznotarealplacexyz')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});
