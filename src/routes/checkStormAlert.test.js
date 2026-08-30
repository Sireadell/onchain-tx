import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { __clearWeatherCachesForTesting } from '../lib/weatherForecast.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('storm-alert: missing location answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/storm-alert`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('storm-alert: place name returns a risk grade with supporting figures', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/storm-alert?location=Miami`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.ok(['LOW', 'MODERATE', 'HIGH', 'SEVERE'].includes(body.risk_level));
  assert.equal(typeof body.peak_gust_kmh, 'number');
  assert.equal(typeof body.beaufort_force, 'number');
  assert.equal(typeof body.thunderstorm_hours, 'number');
});

test('storm-alert: unrecognized location answered with guidance, not a 500', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/storm-alert?location=${encodeURIComponent('zzzznotarealplacexyz')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

// Same defect as weather-forecast: "is there a storm risk in Miami this
// weekend" is the question miner.yaml advertises, and it was being refused.
test('storm-alert: answers a whole question naming the place', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/storm-alert?location=${encodeURIComponent('is there a storm risk in Miami this weekend')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(body.location, /Miami/);
  assert.ok(body.recommended_action.length > 0);
});

// Guards the window bug the same review found: the risk window was sliced
// from index 0 of the hourly data, which is midnight local, so the reported
// peak gust for "the next 48 hours" could be an hour that had already
// happened, and the window stopped short of the real 48 hours.
test('storm-alert: the window starts now, not at midnight', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/storm-alert?location=Miami`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.hours_assessed, 48);
  // window_start is naive local time; compare against local time in the
  // location's own zone rather than this machine's.
  const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: body.timezone }));
  const startedAt = new Date(body.window_start);
  const driftHours = Math.abs(startedAt - localNow) / 3_600_000;
  assert.ok(driftHours <= 1.5, `window starts ${driftHours.toFixed(1)}h from now (${body.window_start}, now ${localNow.toISOString()})`);
  assert.ok(new Date(body.peak_gust_time) >= startedAt, 'peak gust must be inside the future window');
});

// Same defect as weather-forecast (found live 2026-08-29): an upstream
// rate limit was being reported to callers as invalid_input instead of a
// real error status.
test('storm-alert: an upstream failure is reported as a real error, not invalid_input', async (t) => {
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
  const res = await fetch(`${base}/storm-alert?location=Miami`);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.status, 'error');
  assert.doesNotMatch(body.summary, /invalid_input/);
  assert.match(body.summary, /temporarily unavailable/);
});

// Same fix as weather-forecast: a repeated question for the same place
// must be served from cache instead of re-hitting Open-Meteo.
test('storm-alert: a repeated question for the same place is served from cache, not refetched', async (t) => {
  __clearWeatherCachesForTesting();
  const base = startServer(t);
  const first = await (await fetch(`${base}/storm-alert?location=Nairobi`)).json();
  const second = await (await fetch(`${base}/storm-alert?location=Nairobi`)).json();
  assert.equal(first.status, 'ok');
  assert.equal(second.checked_at, first.checked_at, 'a cached answer must report when the data was actually fetched, not the request time');
});

// The question the engine actually sends. Pulled verbatim from the live
// question feed (/api/daemon/api/questions) on 2026-08-30, where this exact
// template was 50 of the 90 sampled weather/storm questions, with a further
// 25 using the "right now" variant below. Every one was being answered
// "invalid_input" because coordinates written out in words were not
// recognised as a location and "in 44 hours" was not recognised as a window.
test('storm-alert: answers the real engine question, coordinates written out in words', async (t) => {
  __clearWeatherCachesForTesting();
  const base = startServer(t);
  const question = 'What is the storm risk at latitude 14.6042, longitude 120.9822 in 44 hours? Report wind speed, gusts, precipitation and an overall risk between 0 and 1.';
  const res = await fetch(`${base}/storm-alert?location=${encodeURIComponent(question)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.latitude, 14.6042);
  assert.equal(body.longitude, 120.9822);
  // The horizon asked for must be honoured, not silently replaced by the default.
  assert.equal(body.hours_assessed, 44);
  // Every figure the question explicitly asks to be reported.
  assert.equal(typeof body.max_wind_speed_kmh, 'number');
  assert.equal(typeof body.peak_gust_kmh, 'number');
  assert.equal(typeof body.total_precipitation_mm, 'number');
  assert.ok(body.risk_score >= 0 && body.risk_score <= 1, 'risk must be scored between 0 and 1');
});

test('storm-alert: answers the "right now" variant of the same engine question', async (t) => {
  __clearWeatherCachesForTesting();
  const base = startServer(t);
  const question = 'What is the storm risk at latitude -5.1486, longitude 119.4319 right now? Report wind speed, gusts, precipitation and an overall risk between 0 and 1.';
  const res = await fetch(`${base}/storm-alert?location=${encodeURIComponent(question)}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.latitude, -5.1486);
  assert.equal(body.longitude, 119.4319);
  assert.ok(body.risk_score >= 0 && body.risk_score <= 1);
});
