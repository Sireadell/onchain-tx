import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkCurrencyExchange.js';
import { __clearCurrencyCacheForTesting } from '../lib/currencyExchange.js';

// This route is not wired into app.js yet (coordinator integrates it by
// hand), so tests build a minimal standalone app with just this router
// mounted, the same async-error forwarding and error handler app.js uses.
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/currency-exchange', forwardAsyncErrors(router));
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

function stubFrankfurter(t, { status = 200, body } = {}) {
  __clearCurrencyCacheForTesting();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://api.frankfurter.app')) {
      calls.push(str);
      return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearCurrencyCacheForTesting(); });
  return calls;
}

test('CURRENCY_EXCHANGE happy path converts using from/to codes', async (t) => {
  const base = startServer(t);
  stubFrankfurter(t, { body: { amount: 1, base: 'USD', date: '2026-09-17', rates: { EUR: 0.92 } } });

  const res = await fetch(`${base}/currency-exchange?from=USD&to=EUR&amount=100`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.from, 'USD');
  assert.equal(json.to, 'EUR');
  assert.equal(json.result, 92);
  assert.match(json.summary, /100 USD is worth 92 EUR/);
});

test('CURRENCY_EXCHANGE accepts full currency names', async (t) => {
  const base = startServer(t);
  stubFrankfurter(t, { body: { amount: 1, base: 'USD', date: '2026-09-17', rates: { EUR: 0.92 } } });

  const res = await fetch(`${base}/currency-exchange?from=dollars&to=euros&amount=10`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.from, 'USD');
  assert.equal(json.to, 'EUR');
});

test('CURRENCY_EXCHANGE derives pair from a whole question', async (t) => {
  const base = startServer(t);
  stubFrankfurter(t, { body: { amount: 1, base: 'USD', date: '2026-09-17', rates: { EUR: 0.92 } } });

  const res = await fetch(`${base}/currency-exchange?question=${encodeURIComponent('How much is 50 dollars in euros?')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.from, 'USD');
  assert.equal(json.to, 'EUR');
  assert.equal(json.amount, 50);
});

test('CURRENCY_EXCHANGE defaults amount to 1 when omitted', async (t) => {
  const base = startServer(t);
  stubFrankfurter(t, { body: { amount: 1, base: 'GBP', date: '2026-09-17', rates: { JPY: 190.5 } } });

  const res = await fetch(`${base}/currency-exchange?from=GBP&to=JPY`);
  const json = await res.json();
  assert.equal(json.amount, 1);
  assert.equal(json.result, 190.5);
});

test('CURRENCY_EXCHANGE missing params refuses with 200, not 4xx', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/currency-exchange`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('CURRENCY_EXCHANGE only a target currency refuses honestly', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/currency-exchange?to=EUR`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
  assert.match(json.summary, /source currency/);
});

test('CURRENCY_EXCHANGE unsupported currency (crypto ticker) refuses honestly', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/currency-exchange?from=BTC&to=USD`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
  assert.match(json.summary, /not a currency the ECB reference rate feed publishes/);
});

test('CURRENCY_EXCHANGE nonsense input refuses without crashing', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/currency-exchange?from=${encodeURIComponent('asdkjaslkdj')}&to=EUR`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.status === 'invalid_input' || json.status === 'ok');
});

test('CURRENCY_EXCHANGE handles a 12,000+ char input without crashing', async (t) => {
  const base = startServer(t);
  const long = 'a'.repeat(12_500);
  const res = await fetch(`${base}/currency-exchange?question=${encodeURIComponent(long)}`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.status, 'invalid_input');
});

test('CURRENCY_EXCHANGE upstream failure returns a real error code, not invalid_input', async (t) => {
  const base = startServer(t);
  stubFrankfurter(t, { status: 500, body: {} });

  const res = await fetch(`${base}/currency-exchange?from=USD&to=EUR`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.status, 'error');
});

test('CURRENCY_EXCHANGE same currency both sides is an identity conversion', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/currency-exchange?from=USD&to=USD&amount=25`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.result, 25);
  assert.equal(json.rate, 1);
});

test('CURRENCY_EXCHANGE POST works the same as GET', async (t) => {
  const base = startServer(t);
  stubFrankfurter(t, { body: { amount: 1, base: 'USD', date: '2026-09-17', rates: { EUR: 0.92 } } });

  const res = await fetch(`${base}/currency-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'USD', to: 'EUR', amount: 5 }),
  });
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.result, 4.6);
});

// Real routed questions (2026-09-17 replay), all previously refused.
test('CURRENCY_EXCHANGE a single named currency defaults the target to USD', async (t) => {
  const base = startServer(t);
  stubFrankfurter(t, { body: { amount: 1, base: 'EUR', date: '2026-09-17', rates: { USD: 1.15 } } });
  for (const q of ['whats the fx rate of euro?', 'what is fx rate of euro']) {
    const res = await fetch(`${base}/currency-exchange?query=${encodeURIComponent(q)}`);
    const json = await res.json();
    assert.equal(json.status, 'ok', q);
    assert.equal(json.from, 'EUR', q);
    assert.equal(json.to, 'USD', q);
  }
});

test('CURRENCY_EXCHANGE "how many X is N Y" reverse word order is parsed', async (t) => {
  const base = startServer(t);
  stubFrankfurter(t, { body: { amount: 100, base: 'USD', date: '2026-09-17', rates: { MXN: 17.19 } } });
  const res = await fetch(`${base}/currency-exchange?query=${encodeURIComponent('How many pesos is 100 dollars?')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.from, 'USD');
  assert.equal(json.to, 'MXN');
  assert.equal(json.amount, 100);
});

test('CURRENCY_EXCHANGE an adjective-prefixed currency name ("British pounds") is not mistaken for a bare three-letter code', async (t) => {
  const base = startServer(t);
  const calls = stubFrankfurter(t, { body: { amount: 75, base: 'CHF', date: '2026-09-17', rates: { GBP: 0.91 } } });
  const res = await fetch(`${base}/currency-exchange?query=${encodeURIComponent('Convert 75 Swiss francs to British pounds')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.from, 'CHF');
  assert.equal(json.to, 'GBP', 'must resolve to GBP, not "BRI" (the first three letters of "British")');
  assert.match(calls[0], /to=GBP/);
});

test('CURRENCY_EXCHANGE a currency this feed does not carry is refused by name, not a generic message', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/currency-exchange?query=${encodeURIComponent('How much is 1000 Naira in US dollars?')}`);
  const json = await res.json();
  assert.equal(json.status, 'invalid_input');
  assert.match(json.summary, /NGN/);
});

test('CURRENCY_EXCHANGE pair reader handles slash, dash and joined market notation', async () => {
  const { parseCurrencyParams } = await import('./checkCurrencyExchange.js');
  const read = (query) => parseCurrencyParams({ query });
  assert.deepEqual(read('rate for AUD/USD today?'), { from: 'AUD', to: 'USD', amount: undefined });
  assert.deepEqual(read('EUR-GBP now'), { from: 'EUR', to: 'GBP', amount: undefined });
  assert.deepEqual(read('EURUSD right now'), { from: 'EUR', to: 'USD', amount: undefined });
  assert.deepEqual(read('convert 250 GBP/JPY'), { from: 'GBP', to: 'JPY', amount: 250 });
  assert.equal(read('NGN/USD rate').from, 'NGN');
  assert.equal(read('and/the question').from, null);
  assert.deepEqual(read('100 dollars to euros'), { from: 'USD', to: 'EUR', amount: 100 });
});
