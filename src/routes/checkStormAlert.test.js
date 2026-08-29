import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';

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
