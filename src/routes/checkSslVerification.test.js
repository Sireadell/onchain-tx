import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';

// SSL_VERIFICATION does a real TLS handshake (lib/sslCheck.js) rather than
// calling a mockable HTTP API — there's no request/response to intercept
// with a fetch mock. Tests below hit real hosts: a domain with a
// certificate every trust store accepts, and a domain guaranteed not to
// resolve. This is slower and network-dependent, an accepted trade-off
// for an endpoint whose entire job is "what does a live TLS handshake say
// right now" — mocking that would test something other than the endpoint.

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('ssl-check: missing domain rejected', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/ssl-check`);
  assert.equal(res.status, 400);
});

test('ssl-check: full URL instead of bare hostname rejected', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/ssl-check?domain=${encodeURIComponent('https://example.com/path')}`);
  assert.equal(res.status, 400);
});

test('ssl-check: real domain with a trusted certificate returns valid', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/ssl-check?domain=google.com`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.valid, true);
  assert.equal(body.authorized, true);
  assert.ok(body.days_until_expiry > 0);
  assert.ok(body.issuer);
});

test('ssl-check: unresolvable domain returns unreachable, not an error', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/ssl-check?domain=this-domain-does-not-exist-txlens-test.invalid`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'unreachable');
  assert.equal(body.valid, null);
});
