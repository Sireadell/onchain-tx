import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveZone, summarisePrices } from './checkGridPowerPrice.js';
import { parseValidatorId, gwei } from './checkValidatorPerformance.js';
import { wantedMetrics } from './checkCloudResourceUsage.js';
import { readValues, pueRating } from './checkDatacenterTelemetry.js';
import { sign, safeEqualHex, toEpochSeconds } from './checkSensorTelemetry.js';
import { resolvePort, congestion } from './checkPortCongestion.js';
import { parseMmsi } from './checkVesselTelemetry.js';
import { readPoint, distanceKm, nearbyEvents } from './checkSatelliteImagery.js';

test('grid zone resolves from a country name and from a question', () => {
  assert.equal(resolveZone('Germany')?.bzn, 'DE-LU');
  assert.equal(resolveZone(undefined, 'what is the power price in France today')?.bzn, 'FR');
  assert.equal(resolveZone('Texas'), null);
});

test('grid price picks the latest slot not in the future', () => {
  const s = summarisePrices([100, 200, 300], [10, 20, 30], 250);
  assert.equal(s.current.p, 20);
  assert.equal(s.min, 10);
  assert.equal(s.max, 30);
  assert.equal(s.avg, 20);
  assert.equal(summarisePrices([], [], 1), null);
});

test('validator id accepts an index, a pubkey and a question', () => {
  assert.equal(parseValidatorId('12345'), '12345');
  assert.equal(parseValidatorId(undefined, 'is validator 777 active'), '777');
  assert.equal(parseValidatorId('abc'), null);
  assert.equal(parseValidatorId(`0x${'a'.repeat(96)}`), `0x${'a'.repeat(96)}`);
  assert.equal(gwei('32000000000'), 32);
});

test('cloud metrics follow the words in the question', () => {
  assert.deepEqual([...wantedMetrics('cpu')], ['cpu']);
  assert.deepEqual([...wantedMetrics(undefined, 'network throughput')].sort(), ['network_rx', 'network_tx']);
  assert.equal(wantedMetrics().size, 4);
});

test('datacenter values read from params and from text', () => {
  const v = readValues({ total_kw: '1500', it_kw: '1000' }, '');
  assert.equal(v.total, 1500);
  assert.equal(v.it, 1000);
  const t = readValues({}, 'total facility power 1,200 kW, IT load 800 kW, inlet temperature 22 C, generator fuel 90%');
  assert.equal(t.total, 1200);
  assert.equal(t.it, 800);
  assert.equal(t.inlet, 22);
  assert.equal(t.fuelPct, 90);
  assert.equal(pueRating(1.1), 'excellent');
  assert.equal(pueRating(1.5), 'average');
  assert.equal(pueRating(2.4), 'poor');
});

test('sensor signature matches only with the right secret', () => {
  const sig = sign('s3cret', 'a1', '21.5', '1700000000');
  assert.ok(safeEqualHex(sig, sign('s3cret', 'a1', '21.5', '1700000000')));
  assert.ok(!safeEqualHex(sig, sign('wrong', 'a1', '21.5', '1700000000')));
  assert.ok(!safeEqualHex(sig, 'abc'));
  assert.equal(toEpochSeconds('1700000000000'), 1700000000);
  assert.equal(toEpochSeconds('2023-11-14T22:13:20Z'), 1700000000);
  assert.equal(toEpochSeconds('nonsense'), null);
});

test('port resolves by name or locode and congestion ignores stale calls', () => {
  assert.equal(resolvePort('Helsinki'), 'FIHEL');
  assert.equal(resolvePort(undefined, 'how busy is FITKU'), 'FITKU');
  assert.equal(resolvePort('Rotterdam'), null);
  const now = Date.parse('2026-11-09T12:00:00Z');
  const calls = [
    { portToVisit: 'FIHEL', portAreaDetails: [{ ata: '2026-11-09T06:00:00Z', atd: null, etd: '2026-11-09T20:00:00Z' }] },
    { portToVisit: 'FIHEL', portAreaDetails: [{ ata: '2026-04-25T18:00:00Z', atd: null, etd: '2026-04-26T18:00:00Z' }] },
    { portToVisit: 'FIHEL', portAreaDetails: [{ ata: null, eta: '2026-11-09T18:00:00Z' }] },
    { portToVisit: 'FITKU', portAreaDetails: [{ ata: '2026-11-09T06:00:00Z', atd: null }] },
  ];
  const c = congestion(calls, 'FIHEL', now);
  assert.equal(c.inPort, 1);
  assert.equal(c.expected, 1);
  assert.equal(Math.round(c.avgStayHours), 6);
});

test('vessel mmsi needs nine digits', () => {
  assert.equal(parseMmsi('230629000'), '230629000');
  assert.equal(parseMmsi(undefined, 'where is 230629000 now'), '230629000');
  assert.equal(parseMmsi('12345'), null);
});

test('satellite point and nearby events', () => {
  assert.deepEqual(readPoint({ lat: '34.05', lon: '-118.24' }, ''), { lat: 34.05, lon: -118.24 });
  assert.deepEqual(readPoint({}, 'fires near 34.05, -118.24'), { lat: 34.05, lon: -118.24 });
  assert.equal(readPoint({ lat: '200', lon: '0' }, ''), null);
  assert.ok(Math.abs(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.2) < 0.5);
  const events = [
    { title: 'Near fire', categories: [{ title: 'Wildfires' }], geometry: [{ type: 'Point', coordinates: [-118.2, 34.1], date: 'd' }] },
    { title: 'Far storm', categories: [{ title: 'Severe Storms' }], geometry: [{ type: 'Point', coordinates: [52, -13], date: 'd' }] },
  ];
  const near = nearbyEvents(events, { lat: 34.05, lon: -118.24 }, 300);
  assert.equal(near.length, 1);
  assert.equal(near[0].title, 'Near fire');
});
