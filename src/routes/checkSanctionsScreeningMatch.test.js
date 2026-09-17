import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkSanctionsScreeningMatch.js';
import { __resetSanctionsCacheForTesting } from '../lib/sanctionsScreening.js';

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/sanctions-screening', forwardAsyncErrors(router));
  app.use(errorHandler);
  return app;
}

function startServer(t) {
  const server = buildTestApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

const SAMPLE_CSV = [
  '1,"DOE, John","individual","SDGT","Businessman","-0-","-0-","-0-","-0-","-0-","-0-","Aliases: JOHNNY DOE"',
  '2,"ACME EXPORTS LTD","entity","CUBA","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"',
  '3,"SMITH, Robert","individual","SDNTK","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"',
].join('\n');

function stubOfac(t, { status = 200, body = SAMPLE_CSV } = {}) {
  __resetSanctionsCacheForTesting();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://www.treasury.gov')) {
      calls.push(str);
      return new Response(body, { status, headers: { 'Content-Type': 'text/csv' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __resetSanctionsCacheForTesting(); });
  return calls;
}

test('SANCTIONS_SCREENING_MATCH happy path finds a match', async (t) => {
  const base = startServer(t);
  stubOfac(t);
  const res = await fetch(`${base}/sanctions-screening?name=${encodeURIComponent('John Doe')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.matched, true);
  assert.match(json.summary, /DOE, John/);
});

test('SANCTIONS_SCREENING_MATCH clean name with no match answers honestly', async (t) => {
  const base = startServer(t);
  stubOfac(t);
  const res = await fetch(`${base}/sanctions-screening?name=${encodeURIComponent('Taylor Swift')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.matched, false);
  assert.match(json.summary, /No match/);
});

test('SANCTIONS_SCREENING_MATCH accepts alias params (entity, q)', async (t) => {
  const base = startServer(t);
  stubOfac(t);
  const res1 = await fetch(`${base}/sanctions-screening?entity=${encodeURIComponent('Acme Exports Ltd')}`);
  const json1 = await res1.json();
  assert.equal(json1.matched, true);

  const res2 = await fetch(`${base}/sanctions-screening?q=${encodeURIComponent('Robert Smith')}`);
  const json2 = await res2.json();
  assert.equal(json2.matched, true);
});

test('SANCTIONS_SCREENING_MATCH derives name from a whole question', async (t) => {
  const base = startServer(t);
  stubOfac(t);
  const res = await fetch(`${base}/sanctions-screening?question=${encodeURIComponent('Is John Doe sanctioned?')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.matched, true);
});

test('SANCTIONS_SCREENING_MATCH missing param refuses with 200, not 4xx', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/sanctions-screening`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('SANCTIONS_SCREENING_MATCH nonsense/numeric input refuses without crashing', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/sanctions-screening?name=12345`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('SANCTIONS_SCREENING_MATCH handles a 12,000+ char input without crashing', async (t) => {
  const base = startServer(t);
  stubOfac(t);
  const long = 'A'.repeat(12_500);
  const res = await fetch(`${base}/sanctions-screening?name=${encodeURIComponent(long)}`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

test('SANCTIONS_SCREENING_MATCH upstream failure returns a real error code', async (t) => {
  const base = startServer(t);
  stubOfac(t, { status: 500, body: 'server error' });
  const res = await fetch(`${base}/sanctions-screening?name=John Doe`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.status, 'error');
});

test('SANCTIONS_SCREENING_MATCH POST works the same as GET', async (t) => {
  const base = startServer(t);
  stubOfac(t);
  const res = await fetch(`${base}/sanctions-screening`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'John Doe' }),
  });
  const json = await res.json();
  assert.equal(json.matched, true);
});
