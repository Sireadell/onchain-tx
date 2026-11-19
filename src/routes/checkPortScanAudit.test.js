import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { targetFromText, assess, resolveTarget, reservedRange, askedPort } from '../lib/portAudit.js';

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
  assert.match(body.answer, /Shodan InternetDB/);
  assert.match(body.answer, /No connection was made to the host/);
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
  const body = await (await fetch(`${base}/port-audit?query=${encodeURIComponent('Scan 192.168.1.100 for open ports')}`)).json();
  assert.equal(called, false);
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'not_found');
  assert.equal(body.found, false);
  assert.match(body.answer, /192\.168\.0\.0\/16/);
  assert.match(body.answer, /RFC 1918/);
  assert.equal(body.summary, undefined);
});

test('port audit: reserved ranges are named', () => {
  assert.match(reservedRange('10.1.2.3'), /10\.0\.0\.0\/8/);
  assert.match(reservedRange('127.0.0.1'), /loopback/);
  assert.match(reservedRange('203.0.113.5'), /documentation/);
  assert.equal(askedPort('What runs on port 80 of example.com?'), 80);
  assert.equal(askedPort('Which ports are open on example.com?'), null);
});

test('port audit: the port asked about is answered first, CDN edges are named', async (t) => {
  const base = startServer(t);
  stubFetch(t, async () => new Response(JSON.stringify({ ip: '45.33.32.156', ports: [80, 443, 8080], tags: ['cdn'], vulns: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const body = await (await fetch(`${base}/port-audit?query=${encodeURIComponent('What services are running on port 80 of 45.33.32.156?')}`)).json();
  assert.match(body.answer, /^On 45\.33\.32\.156, port 80 is open and serves HTTP\./);
  assert.match(body.answer, /CDN edge/);
  assert.equal(body.found, true);
  const shut = await (await fetch(`${base}/port-audit?query=${encodeURIComponent('Is port 22 open on 45.33.32.156?')}`)).json();
  assert.match(shut.answer, /^On 45\.33\.32\.156, port 22 is not open/);
});

test('port audit: a host name containing "private" that does not resolve is not called a private address', async (t) => {
  const base = startServer(t);
  stubFetch(t, async () => new Response('{}'));
  const body = await (await fetch(`${base}/port-audit?query=${encodeURIComponent('Which ports are open on private-api.invalid?')}`)).json();
  assert.notEqual(body.verdict, 'not_found');
  assert.doesNotMatch(JSON.stringify(body), /IPv6 range/);
});
