import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStockQuote, TickerNotFoundError } from './stockPriceApi.js';

function withFetchMock(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => handler(String(url), ...rest);
  t.after(() => {
    globalThis.fetch = original;
  });
}

function withTwelveDataKey(t) {
  const original = process.env.TWELVE_DATA_API_KEY;
  process.env.TWELVE_DATA_API_KEY = 'test-key';
  t.after(() => {
    if (original === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = original;
  });
}

test('getStockQuote never calls symbol search when the direct quote succeeds', async (t) => {
  withTwelveDataKey(t);
  let searched = false;
  withFetchMock(t, async (url) => {
    if (url.includes('symbol_search')) {
      searched = true;
      return { ok: true, json: async () => ({ data: [] }) };
    }
    assert.match(url, /symbol=AAPL/);
    return { ok: true, json: async () => ({ close: '319.7', currency: 'USD' }) };
  });
  const quote = await getStockQuote('AAPL');
  assert.equal(searched, false);
  assert.equal(quote.priceUsd, 319.7);
  assert.equal(quote.resolvedTicker, 'AAPL');
});

test('getStockQuote falls back to symbol search when the ticker as typed is not found', async (t) => {
  withTwelveDataKey(t);
  const calls = [];
  withFetchMock(t, async (url) => {
    calls.push(url);
    if (url.includes('symbol_search')) {
      assert.match(url, /symbol=Apple/);
      return { ok: true, json: async () => ({ data: [{ symbol: 'AAPL' }] }) };
    }
    if (url.includes('symbol=Apple')) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ status: 'error', message: '**symbol** or **figi** parameter is missing or invalid.' }),
      };
    }
    if (url.includes('yahoo') && url.endsWith('/Apple')) {
      return { status: 404 };
    }
    assert.match(url, /symbol=AAPL/);
    return { ok: true, json: async () => ({ close: '319.7', currency: 'USD' }) };
  });
  const quote = await getStockQuote('Apple');
  assert.equal(quote.priceUsd, 319.7);
  assert.equal(quote.resolvedTicker, 'AAPL');
  // proves the direct attempt happened before the search fallback, not
  // that search was skipped
  assert.ok(calls[0].includes('symbol=Apple') && !calls[0].includes('symbol_search'));
});

test('getStockQuote does not 502 when a name cannot be resolved by search or providers', async (t) => {
  withTwelveDataKey(t);
  withFetchMock(t, async (url) => {
    if (url.includes('symbol_search')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    if (url.includes('twelvedata')) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: async () => ({ status: 'error', message: '**symbol** or **figi** parameter is missing or invalid.' }),
      };
    }
    return { status: 404 };
  });
  await assert.rejects(getStockQuote('Not A Real Company'), TickerNotFoundError);
});

test('getStockQuote skips symbol search entirely without a configured key', async (t) => {
  const original = process.env.TWELVE_DATA_API_KEY;
  delete process.env.TWELVE_DATA_API_KEY;
  t.after(() => {
    if (original !== undefined) process.env.TWELVE_DATA_API_KEY = original;
  });
  let called = false;
  withFetchMock(t, async (url) => {
    if (url.includes('symbol_search')) called = true;
    return { status: 404 };
  });
  await assert.rejects(getStockQuote('Apple'), TickerNotFoundError);
  assert.equal(called, false);
});
