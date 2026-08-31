import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { __clearWeatherCachesForTesting } from '../lib/weatherForecast.js';

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

test('weather-forecast: unrelated free-text question is refused before any call', async (t) => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (String(url).startsWith('http://127.0.0.1:')) return original(url, ...rest);
    called = true;
    throw new Error('should not be called');
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);

  const res = await fetch(`${base}/weather-forecast?location=${encodeURIComponent('What is the population of Tokyo?')}`);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
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

// Guards the mislabeling bug found live 2026-08-29: Render's shared
// free-tier egress IP got rate-limited (429) by Open-Meteo, and every one
// of those upstream failures was reported to callers as invalid_input —
// "the question is unusable" — when the real cause was TxLens's own
// upstream being unavailable. Stubs global fetch to force a persistent 429
// (past the one built-in retry) and asserts the response is a real error
// status, not a disguised-as-caller's-fault 200.
test('weather-forecast: an upstream failure is reported as a real error, not invalid_input', async (t) => {
  __clearWeatherCachesForTesting();
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('open-meteo.com')) {
      return new Response('rate limited', { status: 429 });
    }
    return realFetch(url);
  };
  t.after(() => { global.fetch = realFetch; });

  const base = startServer(t);
  const res = await fetch(`${base}/weather-forecast?location=London`);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.status, 'error');
  assert.doesNotMatch(body.summary, /invalid_input/);
  assert.match(body.summary, /temporarily unavailable/);
});

// The actual fix for the shared-IP rate-limit problem: repeated questions
// about the same place, close together, must not re-hit Open-Meteo at all.
// Confirmed live against a competing miner on this intent (2026-08-29) that
// this is exactly how it avoids the same problem.
test('weather-forecast: a repeated question for the same place is served from cache, not refetched', async (t) => {
  __clearWeatherCachesForTesting();
  const base = startServer(t);
  const first = await (await fetch(`${base}/weather-forecast?location=Paris`)).json();
  const second = await (await fetch(`${base}/weather-forecast?location=Paris`)).json();
  assert.equal(first.status, 'ok');
  assert.equal(second.checked_at, first.checked_at, 'a cached answer must report when the data was actually fetched, not the request time');
});

// The precipitation-probability clause is unit-tested rather than probed
// live: whether any given city has probability data varies by region and
// by day, so a live assertion would pass or fail for the wrong reason.
import { maxProbability, precipProbabilityClause } from './checkWeatherForecast.js';

test('weather-forecast: a missing probability is not reported as zero', () => {
  // MET Norway publishes no probability outside the Nordics, so every day
  // carries null. Answering "0%" there states a fact nobody measured.
  assert.equal(maxProbability([{ precipitation_probability_pct: null }, {}]), null);
  assert.equal(precipProbabilityClause(null, 12), '');
});

test('weather-forecast: never claims 0% chance while forecasting rain', () => {
  // The live contradiction this fixes: "10.1 mm in total, with the chance
  // of precipitation peaking at 0%", seen at 14.6042, 120.9822.
  assert.equal(precipProbabilityClause(0, 10.1), '');
});

test('weather-forecast: a real 0% with no rain forecast is still reported', () => {
  // 0% is genuine information when it agrees with a dry forecast, so it is
  // dropped only where it contradicts the rest of the sentence.
  assert.equal(precipProbabilityClause(0, 0), ', with the chance of precipitation peaking at 0%');
  assert.equal(precipProbabilityClause(70, 4), ', with the chance of precipitation peaking at 70%');
});

test('weather-forecast: the peak probability ignores days with no figure', () => {
  const days = [{ precipitation_probability_pct: 20 }, { precipitation_probability_pct: null }, { precipitation_probability_pct: 65 }];
  assert.equal(maxProbability(days), 65);
});
