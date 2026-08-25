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

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (typeof url === 'string' && url.startsWith('https://query1.finance.yahoo.com/')) {
      return handler(url, ...rest);
    }
    return original(url, ...rest);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('stock-price: missing ticker rejected before any call', async (t) => {
  let called = false;
  mockFetch(t, async () => {
    called = true;
    throw new Error('should not be called');
  });
  const base = startServer(t);

  const res = await fetch(`${base}/stock-price`);
  assert.equal(res.status, 400);
  assert.equal(called, false);
});

test('stock-price: successful lookup returns price_usd and canonical', async (t) => {
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({
      chart: {
        result: [{
          meta: { regularMarketPrice: 309.69, currency: 'USD', fullExchangeName: 'NasdaqGS', regularMarketTime: 1787676478 },
        }],
      },
    }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/stock-price?ticker=AAPL`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.price_usd, 309.69);
  assert.equal(body.currency, 'USD');
  assert.equal(body.exchange, 'NasdaqGS');
  assert.equal(body.canonical, 'ticker:AAPL:309.69');
  assert.ok(body.as_of);
});

test('stock-price: unknown ticker returns not_found, not an error', async (t) => {
  mockFetch(t, async () => ({
    status: 404,
    statusText: 'Not Found',
    json: async () => ({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/stock-price?ticker=NOTAREALTICKER`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'not_found');
  assert.equal(body.price_usd, null);
});
