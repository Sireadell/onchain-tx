import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkMacroEconomicIndicator.js';
import { __clearMacroCacheForTesting } from '../lib/macroData.js';

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/macro-economic-indicator', forwardAsyncErrors(router));
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

function worldBankBody(value, date = '2025') {
  return [{ page: 1 }, [{ country: { value: 'Japan' }, date, value }]];
}

function stubWorldBank(t, spec) {
  __clearMacroCacheForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://api.worldbank.org')) {
      const status = spec && typeof spec === 'object' && 'status' in spec && 'body' in spec ? spec.status : 200;
      const body = spec && typeof spec === 'object' && 'status' in spec && 'body' in spec ? spec.body : spec;
      return new Response(JSON.stringify(body ?? []), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearMacroCacheForTesting(); });
}

test('MACRO_ECONOMIC_INDICATOR happy path: country name + indicator name', async (t) => {
  const base = startServer(t);
  stubWorldBank(t, worldBankBody(1.5));
  const res = await fetch(`${base}/macro-economic-indicator?country=Japan&indicator=GDP%20growth`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.value, 1.5);
  assert.match(json.summary, /GDP growth/);
});

test('MACRO_ECONOMIC_INDICATOR accepts ISO country code and indicator code', async (t) => {
  const base = startServer(t);
  stubWorldBank(t, worldBankBody(2.9));
  const res = await fetch(`${base}/macro-economic-indicator?country=JP&indicator=FP.CPI.TOTL.ZG`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.indicator, 'inflation');
});

test('MACRO_ECONOMIC_INDICATOR missing params refuses with 200, not 4xx', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/macro-economic-indicator`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('MACRO_ECONOMIC_INDICATOR free-text question extracts country and indicator', async (t) => {
  const base = startServer(t);
  stubWorldBank(t, worldBankBody(3.1));
  const res = await fetch(`${base}/macro-economic-indicator?question=${encodeURIComponent('What is the unemployment rate in Germany?')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.indicator, 'unemployment');
});

test('MACRO_ECONOMIC_INDICATOR unrecognisable country refuses honestly', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/macro-economic-indicator?country=Wakanda&indicator=GDP`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('MACRO_ECONOMIC_INDICATOR unrecognisable indicator refuses honestly', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/macro-economic-indicator?country=Japan&indicator=moon%20phase`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('MACRO_ECONOMIC_INDICATOR handles a 12,000+ char input without crashing', async (t) => {
  const base = startServer(t);
  const long = 'a'.repeat(12_500);
  const res = await fetch(`${base}/macro-economic-indicator?country=${encodeURIComponent(long)}&indicator=GDP`);
  assert.equal(res.status, 200);
});

test('MACRO_ECONOMIC_INDICATOR upstream failure returns a real error code', async (t) => {
  const base = startServer(t);
  stubWorldBank(t, { status: 500, body: [] });
  const res = await fetch(`${base}/macro-economic-indicator?country=Japan&indicator=GDP`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.status, 'error');
});

test('MACRO_ECONOMIC_INDICATOR POST works the same as GET', async (t) => {
  const base = startServer(t);
  stubWorldBank(t, worldBankBody(1.5));
  const res = await fetch(`${base}/macro-economic-indicator`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: 'Japan', indicator: 'GDP growth' }),
  });
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

// Real routed question (2026-09-18 replay): the router sent the whole
// question in the country field, with no separate indicator param at all,
// and this was refused because the free-text fallback only checked a
// dedicated query/q/question field, not the structured field that had
// actually received the whole sentence.
test('MACRO_ECONOMIC_INDICATOR a whole question in the country field alone is parsed', async (t) => {
  const base = startServer(t);
  stubWorldBank(t, worldBankBody(3.2));
  const res = await fetch(`${base}/macro-economic-indicator?country=${encodeURIComponent("What is Japan's inflation rate?")}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.country, 'Japan');
});

// economic_indicator is the alias name documented in miner.yaml (to avoid
// colliding with THREAT_INTELLIGENCE's unrelated `indicator` field), so it
// must actually work, not just be documented.
test('MACRO_ECONOMIC_INDICATOR accepts economic_indicator as an alias of indicator', async (t) => {
  const base = startServer(t);
  stubWorldBank(t, worldBankBody(3.7));
  const res = await fetch(`${base}/macro-economic-indicator?country=Germany&economic_indicator=unemployment`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

// Real routed question (2026-09-18 replay): "growing" does not contain the
// substring "growth", so it did not match at all.
test('MACRO_ECONOMIC_INDICATOR "economy growing" phrasing resolves to GDP growth', async (t) => {
  const base = startServer(t);
  stubWorldBank(t, worldBankBody(2.1));
  const res = await fetch(`${base}/macro-economic-indicator?country=${encodeURIComponent('How fast is the US economy growing?')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
});
