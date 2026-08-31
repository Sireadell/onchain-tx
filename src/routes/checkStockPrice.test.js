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

function mockTwelveDataFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (String(url).startsWith('https://api.twelvedata.com/')) {
      return handler(String(url), ...rest);
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
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('stock-price: unrelated free-text question is refused before any call', async (t) => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (String(url).startsWith('http://127.0.0.1:')) return original(url, ...rest);
    called = true;
    throw new Error('should not be called');
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);

  const res = await fetch(`${base}/stock-price?question=${encodeURIComponent('What is ETH worth?')}`);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('stock-price: crypto price wording is refused before any upstream call', async (t) => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (String(url).startsWith('http://127.0.0.1:')) return original(url, ...rest);
    called = true;
    throw new Error('should not be called');
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const res = await fetch(`${base}/stock-price?question=${encodeURIComponent('What is the Bitcoin price today?')}`);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('stock-price: uppercase ticker works but generic value questions and terse q are refused', async (t) => {
  let calls = 0;
  mockFetch(t, async () => {
    calls += 1;
    return { status: 404, json: async () => ({ chart: { result: null, error: { code: 'Not Found' } } }) };
  });
  const base = startServer(t);
  const ticker = await fetch(`${base}/stock-price?q=${encodeURIComponent('What is NVDA at?')}`);
  assert.equal((await ticker.json()).status, 'not_found');
  assert.ok(calls > 0);
  const before = calls;
  for (const q of ['house worth', 'painting worth', 'gold trading', 'milk price', 'Eiffel Tower worth', 'TON worth', 'XMR trading', 'PEPE worth']) {
    const res = await fetch(`${base}/stock-price?q=${encodeURIComponent(q)}`);
    assert.equal((await res.json()).status, 'invalid_input', q);
  }
  assert.equal(calls, before);
});

test('stock-price: common ticker and company-name price framing reaches lookup', async (t) => {
  let calls = 0;
  mockFetch(t, async () => {
    calls += 1;
    return { status: 404, json: async () => ({ chart: { result: null, error: { code: 'Not Found' } } }) };
  });
  const base = startServer(t);
  for (const q of ['What is AAPL trading at?', 'What is NVDA price?', 'What is the price of AAPL?', 'How much is NVDA?', 'AAPL today?', 'Apple price today', 'How is Apple trading?']) {
    const res = await fetch(`${base}/stock-price?q=${encodeURIComponent(q)}`);
    assert.equal((await res.json()).status, 'not_found', q);
  }
  assert.ok(calls >= 7);
});

test('stock-price: unrelated free text cannot bypass guard beside ticker=AAPL', async (t) => {
  let called = false;
  mockFetch(t, async () => { called = true; throw new Error('should not be called'); });
  const base = startServer(t);
  const res = await fetch(`${base}/stock-price?ticker=AAPL&question=${encodeURIComponent('weather tomorrow')}`);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('stock-price: successful lookup returns price_usd and canonical', async (t) => {
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({
      chart: {
        result: [{
          meta: { regularMarketPrice: 309.69, currency: 'USD', fullExchangeName: 'NasdaqGS', regularMarketTime: 1787676478, longName: 'Apple Inc.' },
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
  assert.equal(body.company_name, 'Apple Inc.');
  assert.equal(body.canonical, 'ticker:AAPL:309.69');
  assert.ok(body.as_of);
  assert.equal(body.summary, `Apple Inc. (AAPL) is $309.69 USD as of ${body.as_of}.`);
});

test('stock-price: missing company and provider timestamp are not invented', async (t) => {
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({
      chart: {
        result: [{
          meta: { regularMarketPrice: 309.69, currency: 'USD', fullExchangeName: 'NasdaqGS' },
        }],
      },
    }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/stock-price?ticker=AAPL`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.company_name, null);
  assert.equal(body.as_of, null);
  assert.ok(body.retrieved_at);
  assert.equal(body.summary, 'AAPL is $309.69 USD.');
  assert.doesNotMatch(body.summary, /as of/);
});

test('stock-price: non-USD listing keeps its provider currency and does not populate price_usd', async (t) => {
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({
      chart: {
        result: [{
          meta: {
            regularMarketPrice: 123.45,
            currency: 'EUR',
            fullExchangeName: 'XETRA',
            regularMarketTime: 1787676478,
            longName: 'SAP SE',
          },
        }],
      },
    }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/stock-price?ticker=SAP.DE`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.price, 123.45);
  assert.equal(body.price_usd, null);
  assert.equal(body.currency, 'EUR');
  assert.equal(body.company_name, 'SAP SE');
  assert.equal(body.summary, `SAP SE (SAP.DE) is 123.45 EUR as of ${body.as_of}.`);
  assert.doesNotMatch(body.summary, /USD|\$/);
});

test('stock-price: GBp remains pence and is not relabeled as GBP', async (t) => {
  mockFetch(t, async () => ({
    status: 200,
    json: async () => ({
      chart: {
        result: [{
          meta: {
            regularMarketPrice: 72.34,
            currency: 'GBp',
            fullExchangeName: 'London Stock Exchange',
            regularMarketTime: 1787676478,
            longName: 'Vodafone Group Plc',
          },
        }],
      },
    }),
  }));
  const base = startServer(t);

  const res = await fetch(`${base}/stock-price?ticker=VOD.L`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.price, 72.34);
  assert.equal(body.price_usd, null);
  assert.equal(body.currency, 'GBp');
  assert.equal(body.summary, `Vodafone Group Plc (VOD.L) is 72.34 GBp as of ${body.as_of}.`);
  assert.doesNotMatch(body.summary, /\bGBP\b|USD|\$/);
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

test('stock-price: Twelve Data is preferred when configured', async (t) => {
  const oldKey = process.env.TWELVE_DATA_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  t.after(() => {
    if (oldKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = oldKey;
  });

  mockTwelveDataFetch(t, async (url) => {
    assert.equal(new URL(url).searchParams.get('apikey'), 'test-key');
    return {
      status: 200,
      ok: true,
      json: async () => ({
        symbol: 'AAPL', name: 'Apple Inc.', close: '311.42', currency: 'USD', exchange: 'NASDAQ', timestamp: 1787680000,
      }),
    };
  });
  const base = startServer(t);

  const res = await fetch(`${base}/stock-price?ticker=AAPL`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.price_usd, 311.42);
  assert.equal(body.exchange, 'NASDAQ');
  assert.equal(body.company_name, 'Apple Inc.');
  assert.equal(body.price_source, 'twelve_data');
  assert.equal(body.summary, `Apple Inc. (AAPL) is $311.42 USD as of ${body.as_of}.`);
});
