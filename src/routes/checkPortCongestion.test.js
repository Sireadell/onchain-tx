import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { congestion, congestionLevel } from './checkPortCongestion.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function stubPortCalls(t, portCalls) {
  const original = globalThis.fetch;
  const hits = [];
  globalThis.fetch = (url, options) => {
    if (typeof url === 'string' && url.startsWith('https://meri.digitraffic.fi/api/port-call/')) {
      hits.push(url);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ portCalls }) });
    }
    return original(url, options);
  };
  t.after(() => { globalThis.fetch = original; });
  return hits;
}

const get = async (base, query) => (await fetch(`${base}/port-congestion?${new URLSearchParams(query)}`)).json();

test('port: Rotterdam is answered not_found with null counts, never invalid_input', async (t) => {
  const hits = stubPortCalls(t, []);
  const base = startServer(t);

  const body = await get(base, { port: 'Rotterdam' });
  assert.equal(body.status, 'not_found');
  assert.notEqual(body.status, 'invalid_input');
  assert.equal(body.found, false);
  assert.equal(body.vessels_in_port, null);
  assert.equal(body.arrivals_expected_24h, null);
  assert.equal(body.congestion_level, null);
  assert.match(body.summary, /Rotterdam/);
  assert.match(body.summary, /Finnish ports only/);
  assert.equal(hits.length, 0);
});

test('port: a question naming Rotterdam is answered not_found too', async (t) => {
  const base = startServer(t);
  const body = await get(base, { question: 'How congested is the Port of Rotterdam right now?' });
  assert.equal(body.status, 'not_found');
  assert.match(body.summary, /Rotterdam/);
});

test('port: a covered port reports departures in the last 24 hours and a congestion level', async (t) => {
  const now = Date.now();
  const iso = (hours) => new Date(now + hours * 3.6e6).toISOString();
  stubPortCalls(t, [
    { portToVisit: 'FIHEL', portAreaDetails: [{ ata: iso(-6), atd: null, etd: iso(8) }] },
    { portToVisit: 'FIHEL', portAreaDetails: [{ ata: iso(-30), atd: iso(-5) }] },
    { portToVisit: 'FIHEL', portAreaDetails: [{ ata: iso(-60), atd: iso(-40) }] },
    { portToVisit: 'FIHEL', portAreaDetails: [{ ata: null, eta: iso(3) }] },
  ]);
  const base = startServer(t);

  const body = await get(base, { port: 'Helsinki' });
  assert.equal(body.status, 'ok');
  assert.equal(body.found, true);
  assert.equal(body.vessels_in_port, 1);
  assert.equal(body.arrivals_expected_24h, 1);
  assert.equal(body.departed_24h, 1);
  assert.equal(body.congestion_level, 'low');
  assert.match(body.summary, /1 departed in the last 24 hours/);
});

test('port: congestion counts only departures inside the last 24 hours', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const calls = [
    { portToVisit: 'FITKU', portAreaDetails: [{ ata: '2026-11-11T20:00:00Z', atd: '2026-11-12T06:00:00Z' }] },
    { portToVisit: 'FITKU', portAreaDetails: [{ ata: '2026-11-09T20:00:00Z', atd: '2026-11-10T06:00:00Z' }] },
  ];
  assert.equal(congestion(calls, 'FITKU', now).departed, 1);
  assert.equal(congestionLevel(3, 2), 'low');
  assert.equal(congestionLevel(12, 5), 'moderate');
  assert.equal(congestionLevel(20, 10), 'high');
});
