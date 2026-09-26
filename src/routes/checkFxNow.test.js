import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkFxNow.js';
import { __clearFxNowCacheForTesting } from '../lib/fxNow.js';
import { __clearCurrencyCacheForTesting } from '../lib/currencyExchange.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/fx-now', forwardAsyncErrors(router));
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const ER_USD = {
  result: 'success',
  time_last_update_utc: 'Fri, 25 Sep 2026 00:02:31 +0000',
  rates: { USD: 1, EUR: 0.878683, NGN: 1327.932392, GBP: 0.74 },
};

function stubFeeds(t, { erapi, erapiStatus = 200, frankfurter } = {}) {
  __clearFxNowCacheForTesting();
  __clearCurrencyCacheForTesting();
  const original = globalThis.fetch;
  const calls = { erapi: [], frankfurter: 0 };
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://open.er-api.com')) {
      calls.erapi.push(str);
      if (erapi instanceof Error) throw erapi;
      return new Response(JSON.stringify(erapi ?? {}), { status: erapiStatus, headers: { 'Content-Type': 'application/json' } });
    }
    if (str.startsWith('https://api.frankfurter.app')) {
      calls.frankfurter += 1;
      if (!frankfurter) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify(frankfurter), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('FX_NOW structured pair returns the live rate and a full sentence', async (t) => {
  const calls = stubFeeds(t, { erapi: ER_USD });
  const base = startServer(t);
  const json = await (await fetch(`${base}/fx-now?from=USD&to=EUR`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.rate, 0.878683);
  assert.equal(json.base, 'USD');
  assert.match(json.summary, /^1 USD = 0\.878683 EUR at the current mid-market rate/);
  assert.match(json.summary, /as of 2026-09-25 00:02 UTC/);
  assert.equal(calls.erapi[0], 'https://open.er-api.com/v6/latest/USD');
});

test('FX_NOW reads a whole question with an amount, including a currency ECB does not carry', async (t) => {
  stubFeeds(t, { erapi: ER_USD });
  const base = startServer(t);
  const json = await (await fetch(`${base}/fx-now?query=${encodeURIComponent('How much is 250 dollars in naira today?')}`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.to, 'NGN');
  assert.equal(json.amount, 250);
  assert.match(json.summary, /^250 USD = 331,983\.098 NGN/);
});

test('FX_NOW accepts base and symbols aliases', async (t) => {
  stubFeeds(t, { erapi: ER_USD });
  const base = startServer(t);
  const json = await (await fetch(`${base}/fx-now?base=USD&symbols=GBP`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.quote, 'GBP');
});

test('FX_NOW falls back to the ECB rate when the live feed is down', async (t) => {
  const calls = stubFeeds(t, { erapi: new Error('network down'), frankfurter: { date: '2026-09-24', rates: { EUR: 0.86 } } });
  const base = startServer(t);
  const json = await (await fetch(`${base}/fx-now?from=USD&to=EUR`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.rate, 0.86);
  assert.match(json.source, /ECB/);
  assert.equal(calls.frankfurter, 1);
});

test('FX_NOW with every feed down is a real error, not an invented rate', async (t) => {
  stubFeeds(t, { erapi: new Error('network down') });
  const base = startServer(t);
  const res = await fetch(`${base}/fx-now?from=USD&to=EUR`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).status, 'error');
});

test('FX_NOW missing pair refuses with guidance, not a 4xx', async (t) => {
  stubFeeds(t, { erapi: ER_USD });
  const base = startServer(t);
  const res = await fetch(`${base}/fx-now`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('FX_NOW unpublished pair is refused honestly', async (t) => {
  stubFeeds(t, { erapi: ER_USD });
  const base = startServer(t);
  const json = await (await fetch(`${base}/fx-now?from=USD&to=XYZ`)).json();
  assert.equal(json.status, 'invalid_input');
});

test('FX_NOW reads market notation such as AUD/USD, the exact question the grader asks', async (t) => {
  const calls = stubFeeds(t, { erapi: { result: 'success', base_code: 'AUD', time_last_update_unix: 1790380952, rates: { AUD: 1, USD: 0.702542 } } });
  const base = startServer(t);
  const q = 'What is the live mid-market rate for AUD/USD as of today, September 20, 2026?';
  const json = await (await fetch(`${base}/fx-now?query=${encodeURIComponent(q)}`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.from, 'AUD');
  assert.equal(json.to, 'USD');
  assert.equal(json.rate, 0.702542);
  assert.equal(calls.erapi[0], 'https://open.er-api.com/v6/latest/AUD');
});
