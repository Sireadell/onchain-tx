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

test('threat-ip-reputation: missing IP/domain answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/threat-ip-reputation`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('threat-ip-reputation: valid IP address returns threat assessment', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/threat-ip-reputation?ip=8.8.8.8`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.indicator, '8.8.8.8');
  assert.equal(body.indicator_type, 'ip');
  assert.ok(Number.isFinite(body.threat_score));
  assert.ok(typeof body.is_malicious === 'boolean');
  assert.ok(Array.isArray(body.sources_checked));
  assert.ok(body.confidence >= 0 && body.confidence <= 1);
});

test('threat-ip-reputation: valid domain returns threat assessment', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/threat-ip-reputation?domain=google.com`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.indicator, 'google.com');
  assert.equal(body.indicator_type, 'domain');
  assert.ok(Number.isFinite(body.threat_score));
  assert.ok(typeof body.is_malicious === 'boolean');
});

test('threat-ip-reputation: invalid input answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/threat-ip-reputation?ip=not-an-ip`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('threat-ip-reputation: accepts query parameter as fallback', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/threat-ip-reputation?query=8.8.8.8`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.indicator, '8.8.8.8');
});
