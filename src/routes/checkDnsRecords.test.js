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

test('dns-check: missing hostname answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/dns-check`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('dns-check: full URL is resolved to its bare hostname instead of rejected', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/dns-check?hostname=${encodeURIComponent('https://example.com/path')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.hostname, 'example.com');
});

test('dns-check: host:port is resolved to its bare hostname instead of rejected', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/dns-check?hostname=${encodeURIComponent('example.com:443')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.hostname, 'example.com');
});

test('dns-check: hostname query returns proper response structure', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/dns-check?hostname=google.com`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.hostname, 'google.com');
  // Verify response has correct structure
  assert.ok(typeof body.summary === 'string');
  assert.ok(Number.isFinite(body.confidence));
  assert.ok(body.confidence >= 0);
  assert.ok(body.confidence <= 1);
  assert.ok(Array.isArray(body.record_types_checked));
  assert.ok(typeof body.records_found === 'number');
  assert.ok(typeof body.total_records === 'number');
  assert.ok(typeof body.records === 'object');
});

test('dns-check: input with no extractable hostname answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/dns-check?hostname=${encodeURIComponent('is this thing working')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});
