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

// Guards the defect an adversarial review found on 2026-08-29: a whole
// natural-language question was answered "I cannot forecast weather", even
// though it is the exact question miner.yaml advertises this endpoint as
// answering, and every competing miner on the intent parses one.
test('weather-forecast: answers a whole question, leading with what it asked', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast?location=${encodeURIComponent('Will it rain in London tomorrow?')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(body.location, /London/);
  assert.equal(body.when, 'tomorrow');
  assert.equal(body.focus, 'rain');
  // The rain verdict has to come first, not after a temperature range.
  assert.match(body.summary, /^(?:Yes|No), rain/);
  assert.equal(body.days.length, 1);
});

test('weather-forecast: "tomorrow" forecasts tomorrow, not a range starting today', async (t) => {
  const base = startServer(t);
  const today = await (await fetch(`${base}/weather-forecast?location=London&days=1`)).json();
  const tomorrow = await (await fetch(`${base}/weather-forecast?location=${encodeURIComponent('weather in London tomorrow')}`)).json();
  assert.equal(tomorrow.status, 'ok');
  assert.notEqual(tomorrow.days[0].date, today.days[0].date);
});
