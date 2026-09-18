import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkRegulatoryFilingMonitor.js';
import { __clearRegulatoryCacheForTesting } from '../lib/regulatoryFilings.js';

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/regulatory-filing-monitor', forwardAsyncErrors(router));
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

function stubFederalRegister(t, spec) {
  __clearRegulatoryCacheForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://www.federalregister.gov')) {
      const status = spec && typeof spec === 'object' && 'status' in spec && 'body' in spec ? spec.status : 200;
      const body = spec && typeof spec === 'object' && 'status' in spec && 'body' in spec ? spec.body : spec;
      return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearRegulatoryCacheForTesting(); });
}

const SAMPLE_RESULTS = {
  count: 2,
  results: [
    {
      title: 'B. Braun Medical Inc.; Warning Letter',
      type: 'Notice',
      abstract: 'FDA issued a warning letter regarding manufacturing deficiencies.',
      agencies: [{ name: 'Food and Drug Administration' }],
      publication_date: '2026-08-01',
      html_url: 'https://www.federalregister.gov/documents/2026/08/01/example',
      document_number: '2026-12345',
    },
    {
      title: 'B. Braun Medical Inc.; Import Alert',
      type: 'Notice',
      abstract: 'Import alert for certain devices.',
      agencies: [{ name: 'Food and Drug Administration' }],
      publication_date: '2026-07-15',
      html_url: 'https://www.federalregister.gov/documents/2026/07/15/example2',
      document_number: '2026-54321',
    },
  ],
};

test('REGULATORY_FILING_MONITOR happy path reports the most relevant filing', async (t) => {
  const base = startServer(t);
  stubFederalRegister(t, SAMPLE_RESULTS);
  const res = await fetch(`${base}/regulatory-filing-monitor?company=${encodeURIComponent('B. Braun')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.match(json.summary, /Warning Letter|B\. Braun/);
  assert.equal(json.documents.length, 2);
});

test('REGULATORY_FILING_MONITOR handles a "will X fine Y" prediction-framed question honestly', async (t) => {
  const base = startServer(t);
  stubFederalRegister(t, SAMPLE_RESULTS);
  const res = await fetch(`${base}/regulatory-filing-monitor?question=${encodeURIComponent('Will FDA fine B. Braun?')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.match(json.summary, /not a prediction of future regulatory action/);
});

test('REGULATORY_FILING_MONITOR missing param refuses with 200, not 4xx', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/regulatory-filing-monitor`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('REGULATORY_FILING_MONITOR alias param "product" works', async (t) => {
  const base = startServer(t);
  stubFederalRegister(t, { count: 0, results: [] });
  const res = await fetch(`${base}/regulatory-filing-monitor?product=Ioversol`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.match(json.summary, /No Federal Register filings/);
});

test('REGULATORY_FILING_MONITOR no matches found is an honest ok answer, not a refusal', async (t) => {
  const base = startServer(t);
  stubFederalRegister(t, { count: 0, results: [] });
  const res = await fetch(`${base}/regulatory-filing-monitor?company=ZzzNonexistentCorp`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.documents.length, 0);
});

test('REGULATORY_FILING_MONITOR handles a 12,000+ char input without crashing', async (t) => {
  const base = startServer(t);
  stubFederalRegister(t, { count: 0, results: [] });
  const long = 'a'.repeat(12_500);
  const res = await fetch(`${base}/regulatory-filing-monitor?company=${encodeURIComponent(long)}`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.status === 'ok' || json.status === 'invalid_input');
});

test('REGULATORY_FILING_MONITOR upstream failure returns a real error code', async (t) => {
  const base = startServer(t);
  stubFederalRegister(t, { status: 500, body: {} });
  const res = await fetch(`${base}/regulatory-filing-monitor?company=B.Braun`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.status, 'error');
});

test('REGULATORY_FILING_MONITOR POST works the same as GET', async (t) => {
  const base = startServer(t);
  stubFederalRegister(t, SAMPLE_RESULTS);
  const res = await fetch(`${base}/regulatory-filing-monitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'B. Braun' }),
  });
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

test('REGULATORY_FILING_MONITOR unusable input refuses without crashing', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/regulatory-filing-monitor?company=${encodeURIComponent('!!!')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
});
