import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { parseMmsi, parseImo, resetImoCache, navigationalStatus } from './checkVesselTelemetry.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// Stubs the Digitraffic AIS API. `routes` maps a URL fragment to a JSON body
// (or to null for a 404). Anything else goes to the real fetch.
function stubAis(t, routes) {
  const original = globalThis.fetch;
  const hits = [];
  globalThis.fetch = (url, options) => {
    if (typeof url === 'string' && url.startsWith('https://meri.digitraffic.fi/api/ais/v1')) {
      hits.push(url);
      const key = Object.keys(routes).find((k) => url.endsWith(k));
      const body = key ? routes[key] : null;
      if (body === null || body === undefined) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    }
    return original(url, options);
  };
  t.after(() => { globalThis.fetch = original; });
  return hits;
}

const MARVEL = { mmsi: 636017190, name: 'MARVEL', imo: 9225524, callSign: 'ELZE8', shipType: 70, draught: 87, destination: 'TR ISK', eta: Date.parse('2026-11-14T08:00:00Z') };
const get = async (base, query) => (await fetch(`${base}/vessel-telemetry?${new URLSearchParams(query)}`)).json();

test('vessel: ids parse as MMSI (9 digits) or IMO (7 digits)', () => {
  assert.equal(parseMmsi('230629000'), '230629000');
  assert.equal(parseMmsi('9827904'), null);
  assert.equal(parseImo('9827904'), '9827904');
  assert.equal(parseImo('IMO 9454522'), '9454522');
  assert.equal(parseImo(undefined, 'where is IMO 9454522 now'), '9454522');
  assert.equal(parseImo('230629000'), null);
  assert.equal(navigationalStatus(5), 'moored');
  assert.equal(navigationalStatus(1), 'at anchor');
});

test('vessel: no AIS position but known metadata answers found with the details', async (t) => {
  resetImoCache();
  stubAis(t, { '/locations?mmsi=636017190': { features: [] }, '/vessels/636017190': MARVEL });
  const base = startServer(t);

  const body = await get(base, { mmsi: '636017190' });
  assert.equal(body.status, 'ok');
  assert.equal(body.found, true);
  assert.match(body.summary, /MARVEL/);
  assert.match(body.summary, /8\.7/);
  assert.match(body.summary, /no recent AIS position/);
  assert.equal(body.name, 'MARVEL');
  assert.equal(body.imo, 9225524);
  assert.equal(body.call_sign, 'ELZE8');
  assert.equal(body.ship_type, 'cargo ship');
  assert.equal(body.draught_m, 8.7);
  assert.equal(body.destination, 'TR ISK');
  assert.equal(body.eta, '2026-11-14T08:00:00.000Z');
  assert.equal(body.latitude, null);
  assert.equal(body.longitude, null);
});

test('vessel: a position adds navigational status', async (t) => {
  resetImoCache();
  stubAis(t, {
    '/locations?mmsi=230629000': { features: [{ geometry: { coordinates: [24.95, 60.17] }, properties: { sog: 0, cog: 0, heading: 511, navStat: 5, timestampExternal: Date.parse('2026-11-12T00:00:00Z') } }] },
    '/vessels/230629000': { ...MARVEL, mmsi: 230629000, name: 'TEST SHIP' },
  });
  const base = startServer(t);

  const body = await get(base, { mmsi: '230629000' });
  assert.equal(body.status, 'ok');
  assert.equal(body.navigational_status, 'moored');
  assert.equal(body.latitude, 60.17);
  assert.match(body.summary, /moored/);
});

test('vessel: a 7 digit IMO number is mapped to its MMSI through the register', async (t) => {
  resetImoCache();
  const hits = stubAis(t, {
    '/vessels': [{ mmsi: 636017190, imo: 9225524, name: 'MARVEL' }, { mmsi: 1, imo: 0, name: 'X' }],
    '/locations?mmsi=636017190': { features: [] },
    '/vessels/636017190': MARVEL,
  });
  const base = startServer(t);

  const first = await get(base, { mmsi: '9225524' });
  assert.equal(first.status, 'ok');
  assert.equal(first.found, true);
  assert.equal(first.mmsi, 636017190);
  assert.equal(first.name, 'MARVEL');

  // Second lookup reuses the six hour cache: the register is fetched once.
  await get(base, { mmsi: '9225524' });
  assert.equal(hits.filter((u) => u.endsWith('/vessels')).length, 1);
});

test('vessel: an unknown IMO number answers not_found with the same fields, never invalid_input', async (t) => {
  resetImoCache();
  stubAis(t, { '/vessels': [{ mmsi: 636017190, imo: 9225524 }] });
  const base = startServer(t);

  const body = await get(base, { mmsi: '9827904' });
  assert.equal(body.status, 'not_found');
  assert.equal(body.found, false);
  assert.match(body.reason, /9827904/);
  for (const k of ['name', 'imo', 'call_sign', 'ship_type', 'draught_m', 'destination', 'eta', 'latitude', 'longitude', 'navigational_status']) {
    assert.ok(k in body, `missing ${k}`);
  }
  assert.equal(body.latitude, null);
});

test('vessel: an identifier that is neither MMSI nor IMO is answered not_found', async (t) => {
  const base = startServer(t);
  const body = await get(base, { mmsi: 'not-a-ship' });
  assert.equal(body.status, 'not_found');
  assert.notEqual(body.status, 'invalid_input');
  assert.equal(body.found, false);
});

test('vessel: an MMSI with neither position nor metadata is not_found', async (t) => {
  resetImoCache();
  stubAis(t, { '/locations?mmsi=111111111': { features: [] } });
  const base = startServer(t);

  const body = await get(base, { mmsi: '111111111' });
  assert.equal(body.status, 'not_found');
  assert.equal(body.found, false);
});
