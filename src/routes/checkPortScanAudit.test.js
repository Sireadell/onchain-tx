import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { targetFromText, assess, resolveTarget } from '../lib/portAudit.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return original(url, init);
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
}

test('port audit: target is pulled from a question, URL or bare address', () => {
  assert.equal(targetFromText('Which ports are open on scanme.nmap.org?'), 'scanme.nmap.org');
  assert.equal(targetFromText('Audit https://Example.com/login now'), 'example.com');
  assert.equal(targetFromText('ports on 45.33.32.156'), '45.33.32.156');
  assert.equal(targetFromText('is anything exposed'), null);
});

test('port audit: risky services set the level, many CVEs raise it', () => {
  assert.equal(assess({ ports: [22, 3389] }).level, 'high');
  assert.deepEqual(assess({ ports: [3389, 80] }).risky, ['3389/RDP']);
  assert.equal(assess({ ports: [80, 443] }).level, 'low');
  assert.equal(assess({ ports: [80], vulns: ['CVE-2021-44228'] }).level, 'medium');
});

test('port audit: private and internal targets are refused', async () => {
  await assert.rejects(() => resolveTarget('10.0.0.5'), /private/);
  await assert.rejects(() => resolveTarget('localhost'), /not a public host/);
});

test('port audit: reports ports, risky services and CVEs from InternetDB', async (t) => {
  const base = startServer(t);
  let asked = null;
  stubFetch(t, async (url) => {
    asked = url;
    return new Response(JSON.stringify({ ip: '45.33.32.156', ports: [22, 80, 6379], cpes: ['cpe:/a:openbsd:openssh:6.6.1p1'], hostnames: ['scanme.nmap.org'], tags: [], vulns: ['CVE-2018-1303', 'CVE-2022-23943'] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const body = await (await fetch(`${base}/port-audit?query=${encodeURIComponent('Which ports are open on 45.33.32.156?')}`)).json();
  assert.equal(asked, 'https://internetdb.shodan.io/45.33.32.156');
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.open_ports, [22, 80, 6379]);
  assert.deepEqual(body.risky_ports, ['6379/Redis']);
  assert.equal(body.risk_level, 'high');
  assert.match(body.summary, /Shodan InternetDB/);
  assert.match(body.summary, /No connection was made to the host/);
});

test('port audit: an address Shodan has never seen answers not_found, not an error', async (t) => {
  const base = startServer(t);
  stubFetch(t, async () => new Response('{"detail":"No information available"}', { status: 404 }));
  const body = await (await fetch(`${base}/port-audit?host=93.184.216.34`)).json();
  assert.equal(body.verdict, 'not_found');
  assert.deepEqual(body.open_ports, []);
});

test('port audit: no host in the question answers with what is needed', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/port-audit?query=${encodeURIComponent('is my server safe')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('port audit: a private address never reaches Shodan', async (t) => {
  const base = startServer(t);
  let called = false;
  stubFetch(t, async () => { called = true; return new Response('{}'); });
  const body = await (await fetch(`${base}/port-audit?host=192.168.1.1`)).json();
  assert.equal(called, false);
  assert.equal(body.status, 'invalid_input');
});
