import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingest, portCongestion, findAisPort, shipByName, shipByMmsi, resetAisForTests, AIS_PORTS, aisEnabled } from './aisLive.js';

const pos = (mmsi, lat, lon, nav, sog = 0, name = null) => ({
  MessageType: 'PositionReport',
  MetaData: { MMSI: mmsi, ShipName: name ?? `SHIP ${mmsi}`, latitude: lat, longitude: lon, time_utc: '2026-11-24 03:00:00' },
  Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: sog, Cog: 90, TrueHeading: 511, NavigationalStatus: nav } },
});
const stat = (mmsi, type, len = 300) => ({
  MessageType: 'ShipStaticData',
  MetaData: { MMSI: mmsi },
  Message: { ShipStaticData: { Type: type, Destination: 'NLRTM', Dimension: { A: len - 50, B: 50, C: 20, D: 20 }, ImoNumber: 9811000, MaximumStaticDraught: 14.5, Eta: { Month: 11, Day: 25, Hour: 6, Minute: 0 } } },
});

test('feed is off without a key', () => {
  const saved = process.env.AISSTREAM_API_KEY;
  delete process.env.AISSTREAM_API_KEY;
  assert.equal(aisEnabled(), false);
  if (saved) process.env.AISSTREAM_API_KEY = saved;
});

test('ports are found by name and UN/LOCODE', () => {
  assert.equal(findAisPort('What is the current congestion at the Port of Rotterdam?').unlocode, 'NLRTM');
  assert.equal(findAisPort('port congestion for Shanghai (CNSHA)').unlocode, 'CNSHA');
  assert.equal(findAisPort('congestion at Lagos Apapa (NGAPP)').unlocode, 'NGAPP');
  assert.equal(findAisPort('the port of Atlantis'), null);
});

test('port counts split anchored, moored and moving cargo ships', () => {
  resetAisForTests();
  const now = Date.now();
  const r = AIS_PORTS.find((p) => p.unlocode === 'NLRTM');
  for (let i = 0; i < 6; i++) { ingest(stat(244000000 + i, 70), now); ingest(pos(244000000 + i, r.lat + 0.01 * i, r.lon, 1), now); }
  for (let i = 0; i < 4; i++) { ingest(stat(245000000 + i, 80), now); ingest(pos(245000000 + i, r.lat, r.lon + 0.01 * i, 5), now); }
  ingest(stat(246000000, 70), now); ingest(pos(246000000, r.lat, r.lon, 0, 12), now);
  ingest(stat(247000000, 37, 12), now); ingest(pos(247000000, r.lat, r.lon, 1), now); // pleasure craft, left out
  ingest(stat(248000000, 70), now); ingest(pos(248000000, 10, 10, 1), now); // far away, left out
  const c = portCongestion(r, now);
  assert.equal(c.in_area, 11);
  assert.equal(c.waiting_at_anchor, 6);
  assert.equal(c.moored, 4);
  assert.equal(c.underway, 1);
  assert.equal(c.berth_occupancy_proxy, 0.4);
});

test('ships are kept with static data and found by name or MMSI', () => {
  resetAisForTests();
  ingest(stat(353136000, 71, 400));
  ingest(pos(353136000, 31.2, 32.3, 0, 13.4, 'EVER GIVEN'));
  const s = shipByName('Ever Given');
  assert.equal(s.mmsi, '353136000');
  assert.equal(s.sog, 13.4);
  assert.equal(s.destination, 'NLRTM');
  assert.equal(s.eta, '11-25 06:00');
  assert.equal(shipByMmsi('353136000').length, 400);
  ingest({ MessageType: 'PositionReport', MetaData: { MMSI: 'x' }, Message: {} });
  assert.equal(shipByMmsi('x'), null);
});
