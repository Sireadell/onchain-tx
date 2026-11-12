import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { toEpochSeconds, readQuestion, sign } from './checkSensorTelemetry.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const get = async (base, query) => (await fetch(`${base}/sensor-telemetry?${new URLSearchParams(query)}`)).json();

test('sensor: nanosecond and millisecond timestamps become unix seconds', () => {
  assert.equal(toEpochSeconds('1794420244719649590'), 1794420244);
  assert.equal(toEpochSeconds('1794420244719'), 1794420244);
  assert.equal(toEpochSeconds('1794420244'), 1794420244);
});

test('sensor: a nanosecond timestamp gives a sane age instead of a huge negative one', async (t) => {
  const base = startServer(t);
  const realNow = Date.now;
  Date.now = () => 1794420244 * 1000 + 600_000; // ten minutes after the reading
  t.after(() => { Date.now = realNow; });

  const body = await get(base, { sensor_id: 'home/livingroom/temperature', value: '21.5', timestamp: '1794420244719649590', min: '-10', max: '50' });
  assert.equal(body.status, 'ok');
  assert.ok(body.age_seconds >= 0 && body.age_seconds <= 3600, `age ${body.age_seconds}`);
  assert.equal(body.verdict, 'Within range');
});

test('sensor: a question with a reading and a range is judged, not refused', async (t) => {
  const base = startServer(t);
  const body = await get(base, { query: 'Sensor zone-3 reads 31.5 C, expected -5 to 30' });
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'Out of range');
  assert.match(body.summary, /^Out of range\./);
  assert.match(body.summary, /31\.5/);
  assert.match(body.summary, /30/);
  assert.ok(['answer', 'summary'].includes(Object.keys(body)[0]));
  assert.ok(Array.isArray(body.checks.not_performed) && body.checks.not_performed.length > 0);
});

test('sensor: an in-range question answers Within range', async (t) => {
  const base = startServer(t);
  const body = await get(base, { question: 'Is the reading 22 C from rooftop sensor ok if it should be between 10 and 35 C?' });
  assert.equal(body.verdict, 'Within range');
  assert.equal(body.reading, 22);
});

test('sensor: garbage value and timestamp (N/A) still get an Insufficient information answer', async (t) => {
  const base = startServer(t);
  const body = await get(base, { sensor_id: 'LAX_TEMP', value: 'N/A', timestamp: 'N/A', secret: 'N/A', signature: 'N/A' });
  assert.equal(body.status, 'ok');
  assert.notEqual(body.status, 'invalid_input');
  assert.equal(body.verdict, 'Insufficient information');
  assert.match(body.summary, /^Insufficient information\./);
  assert.ok(body.checks.not_performed.length >= 2);
});

test('sensor: unknown value and timestamp words are answered, not refused', async (t) => {
  const base = startServer(t);
  const body = await get(base, { sensor_id: 'rooftop_unit_123_main_st_temp', value: 'unknown', timestamp: 'unknown' });
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'Insufficient information');
});

test('sensor: a text label as the value with limits and a nanosecond timestamp is still answered', async (t) => {
  const base = startServer(t);
  const body = await get(base, { sensor_id: 'home/livingroom/temperature', value: 'weatherstation-12b', timestamp: '1794420244719649590', min: '-10', max: '50' });
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'Insufficient information');
  assert.ok('heartbeat_fresh' in body.checks.performed);
  assert.ok(body.checks.not_performed.some((c) => c.startsWith('within_calibration_bounds')));
});

test('sensor: the HMAC path still works for a real signature and secret', async (t) => {
  const base = startServer(t);
  const ts = String(Math.floor(Date.now() / 1000));
  const good = await get(base, { sensor_id: 'a1', value: '21.5', timestamp: ts, min: '0', max: '40', secret: 's3cret', signature: sign('s3cret', 'a1', '21.5', ts) });
  assert.equal(good.checks.performed.signature_valid, true);
  assert.equal(good.verdict, 'Within range');
  assert.equal(good.valid, true);

  const bad = await get(base, { sensor_id: 'a1', value: '21.5', timestamp: ts, min: '0', max: '40', secret: 's3cret', signature: 'deadbeef' });
  assert.equal(bad.checks.performed.signature_valid, false);
  assert.equal(bad.verdict, 'Anomalous');
  assert.equal(bad.valid, false);
});

test('sensor: readQuestion pulls reading, unit and limits', () => {
  assert.deepEqual(readQuestion('pressure 12 psi, max 10'), { reading: 12, unit: 'psi', min: null, max: 10 });
  const r = readQuestion('humidity is 140% expected 20 to 80');
  assert.equal(r.reading, 140);
  assert.equal(r.unit, '%');
  assert.equal(r.min, 20);
  assert.equal(r.max, 80);
  assert.equal(readQuestion('').reading, null);
});
