import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkRouteEta.js';
import { __clearRoutingCacheForTesting } from '../lib/routing.js';
import { __clearWeatherCachesForTesting } from '../lib/weatherForecast.js';

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/route-eta', forwardAsyncErrors(router));
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

function stubProviders(t, { geocode, osrm } = {}) {
  __clearRoutingCacheForTesting();
  __clearWeatherCachesForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://geocoding-api.open-meteo.com')) {
      const name = decodeURIComponent(new URL(str).searchParams.get('name') ?? '');
      const hit = typeof geocode === 'function' ? geocode(name) : geocode;
      return new Response(JSON.stringify({ results: hit ? [hit] : [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (str.startsWith('https://router.project-osrm.org')) {
      const status = osrm && typeof osrm === 'object' && 'status' in osrm ? osrm.status : 200;
      const body = osrm && typeof osrm === 'object' && 'status' in osrm ? osrm.body : osrm;
      return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearRoutingCacheForTesting(); __clearWeatherCachesForTesting(); });
}

function londonOrParis(name) {
  const n = name.toLowerCase();
  if (n.includes('london')) return { name: 'London', latitude: 51.5074, longitude: -0.1278, country: 'United Kingdom', feature_code: 'PPLC', population: 9000000 };
  if (n.includes('paris')) return { name: 'Paris', latitude: 48.8566, longitude: 2.3522, country: 'France', feature_code: 'PPLC', population: 2100000 };
  return null;
}

const OSRM_ROUTE = { code: 'Ok', routes: [{ distance: 344000, duration: 14400 }] };

test('ROUTE_ETA happy path with place names', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: londonOrParis, osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?origin=London&destination=Paris`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.distance_km, 344);
  assert.match(json.summary, /London.*to Paris/);
});

test('ROUTE_ETA accepts direct lat,lon coordinates', async (t) => {
  const base = startServer(t);
  stubProviders(t, { osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?origin=51.5074,-0.1278&destination=48.8566,2.3522`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.distance_km, 344);
});

test('ROUTE_ETA accepts OSRM-style coords param', async (t) => {
  const base = startServer(t);
  stubProviders(t, { osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?coords=${encodeURIComponent('-0.1278,51.5074;2.3522,48.8566')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.distance_km, 344);
});

test('ROUTE_ETA derives origin/destination from a whole question', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: londonOrParis, osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?question=${encodeURIComponent('How long to drive from London to Paris?')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

// Real routed phrasing (2026-09-17 replay): "how far is X from Y" has no
// "to" in it at all, so FROM_TO_RE could never match it, and it was refused
// for want of an origin/destination pair. This is destination-first
// phrasing, the mirror image of "from X to Y".
test('ROUTE_ETA derives a pair from "how far is X from Y by car" phrasing', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: londonOrParis, osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?question=${encodeURIComponent('How far is Paris from London by car?')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.match(json.origin, /^London\b/);
  assert.match(json.destination, /^Paris\b/);
});

test('ROUTE_ETA missing destination refuses with 200, not 4xx', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/route-eta?origin=London`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('ROUTE_ETA unsupported mode (walking) refuses honestly', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/route-eta?origin=London&destination=Paris&mode=walking`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
  assert.match(json.summary, /driving/);
});

// The real bug (2026-09-17 live replay): normalizeMode collapsed "no mode
// given" and "a mode nobody has heard of" into the same 'driving' default,
// so mode=teleport silently answered as an ordinary driving route instead
// of being refused, contradicting this endpoint's own documented promise.
test('ROUTE_ETA a genuinely unrecognized mode is refused, not silently treated as driving', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: londonOrParis, osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?origin=London&destination=Paris&mode=teleport`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
  assert.match(json.summary, /teleport/);
  assert.doesNotMatch(json.summary, /approximately.*km/, 'must not have quietly answered as a driving route');
});

test('ROUTE_ETA no mode supplied at all still defaults to driving', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: londonOrParis, osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?origin=London&destination=Paris`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.mode, 'driving');
});

test('ROUTE_ETA unresolvable place name refuses honestly', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: () => null, osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?origin=${encodeURIComponent('Zzznonexistentplacexyz')}&destination=Paris`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('ROUTE_ETA handles a 12,000+ char input without crashing', async (t) => {
  const base = startServer(t);
  const long = 'a'.repeat(12_500);
  const res = await fetch(`${base}/route-eta?origin=${encodeURIComponent(long)}&destination=Paris`);
  assert.equal(res.status, 200);
});

test('ROUTE_ETA upstream OSRM failure returns a real error code', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: londonOrParis, osrm: { status: 500, body: {} } });
  const res = await fetch(`${base}/route-eta?origin=London&destination=Paris`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.status, 'error');
});

test('ROUTE_ETA POST works the same as GET', async (t) => {
  const base = startServer(t);
  stubProviders(t, { osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin: '51.5074,-0.1278', destination: '48.8566,2.3522' }),
  });
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

// London to Paris on OSRM's public demo server has no drivable link across
// the Channel and really does route through a live Portsmouth-Cherbourg
// ferry (confirmed 2026-09-17 against the real API), which reports a
// six-hour crossing as if it were a normal driving leg. This is honest data
// about a real way to make the trip, but a full-confidence "12 hours" would
// mislead a caller who means "how long to drive" the way most people mean
// it, so a ferry leg must lower confidence and add a caveat rather than
// getting the same treatment as an ordinary road trip.
const OSRM_ROUTE_WITH_FERRY = {
  code: 'Ok',
  routes: [{
    distance: 620362.5,
    duration: 43253.6,
    legs: [{
      steps: [
        { mode: 'driving', name: 'A3', distance: 100000, duration: 3600 },
        { mode: 'ferry', name: 'Portsmouth (UK) - Cherbourg-en-Cotentin (F)', distance: 140128, duration: 21600 },
        { mode: 'driving', name: 'Autoroute de Normandie', distance: 380234.5, duration: 18053.6 },
      ],
    }],
  }],
};

test('ROUTE_ETA names a ferry leg honestly and lowers confidence instead of reporting it as a plain driving time', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: londonOrParis, osrm: OSRM_ROUTE_WITH_FERRY });
  const res = await fetch(`${base}/route-eta?origin=London&destination=Paris`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.includes_ferry, true);
  assert.match(json.summary, /ferry/i);
  assert.match(json.summary, /Portsmouth/);
  assert.ok(json.confidence < 0.85, 'a ferry-included route must not carry the same confidence as an ordinary driving route');
  assert.equal(json.ferry.names[0], 'Portsmouth (UK) - Cherbourg-en-Cotentin (F)');
  assert.equal(json.ferry.duration_s, 21600);
});

test('ROUTE_ETA an ordinary route with no ferry step carries no ferry caveat', async (t) => {
  const base = startServer(t);
  stubProviders(t, { geocode: londonOrParis, osrm: OSRM_ROUTE });
  const res = await fetch(`${base}/route-eta?origin=London&destination=Paris`);
  const json = await res.json();
  assert.equal(json.includes_ferry, false);
  assert.equal(json.ferry, null);
  assert.doesNotMatch(json.summary, /ferry/i);
  assert.equal(json.confidence, 0.85);
});
