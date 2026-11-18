import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { routeCodes, bookingRef } from './checkTransitLock.js';

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

test('transit lock: airport codes and the booking reference are read from the question', () => {
  assert.deepEqual(routeCodes('Is my fare locked for JFK to LHR, booking ABC123?'), ['JFK', 'LHR']);
  assert.deepEqual(routeCodes('hold seat SFO-LAX'), ['SFO', 'LAX']);
  assert.equal(bookingRef('Is my fare locked for JFK to LHR, booking ABC123?'), 'ABC123');
  assert.equal(bookingRef('book me a flight'), null);
});

test('transit lock: never claims a lock, reports METAR conditions per airport', async (t) => {
  const base = startServer(t);
  stubFetch(t, async () => new Response(JSON.stringify([
    { icaoId: 'KJFK', fltCat: 'VFR', rawOb: 'METAR KJFK 181851Z 21009KT 10SM', reportTime: '2026-11-18T19:00:00.000Z' },
    { icaoId: 'EGLL', fltCat: 'IFR', rawOb: 'METAR EGLL 181850Z 22007KT 1200 BKN004', reportTime: '2026-11-18T19:00:00.000Z' },
  ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const body = await (await fetch(`${base}/transit-lock?query=${encodeURIComponent('Is my fare locked for JFK to LHR, booking ABC123?')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'unverified');
  assert.equal(body.locked, null);
  assert.equal(body.booking_reference, 'ABC123');
  assert.match(body.summary, /JFK VFR, LHR IFR/);
  assert.match(body.summary, /LHR under instrument conditions/);
  assert.match(body.summary, /reservation record/);
});

test('transit lock: with no airports it still answers honestly', async (t) => {
  const base = startServer(t);
  const body = await (await fetch(`${base}/transit-lock?query=${encodeURIComponent('Can I lock this fare for 24 hours?')}`)).json();
  assert.equal(body.verdict, 'unverified');
  assert.equal(body.locked, null);
  assert.match(body.summary, /cannot be confirmed from public data/);
});

test('transit lock: weather outage does not break the answer', async (t) => {
  const base = startServer(t);
  stubFetch(t, async () => new Response('x', { status: 503 }));
  const body = await (await fetch(`${base}/transit-lock?query=SFO+to+LAX+fare+lock`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /could not be read/);
});

test('transit lock: empty input is answered, not a bare 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/transit-lock`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});
