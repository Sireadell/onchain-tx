import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkCreditScoreVerify.js';
import { __clearEntityRegistryCacheForTesting } from '../lib/entityRegistry.js';

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/credit-score-verify', forwardAsyncErrors(router));
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

function stubGleif(t, spec) {
  __clearEntityRegistryCacheForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://api.gleif.org')) {
      const status = spec && typeof spec === 'object' && 'status' in spec && 'body' in spec ? spec.status : 200;
      const body = spec && typeof spec === 'object' && 'status' in spec && 'body' in spec ? spec.body : spec;
      return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearEntityRegistryCacheForTesting(); });
}

const SAMPLE_MATCH = {
  data: [{
    id: '549300ABC1234567890X',
    attributes: {
      entity: {
        legalName: { name: 'Apple Inc.' },
        jurisdiction: 'US-CA',
        status: 'ACTIVE',
        legalForm: { id: 'XTIU' },
        headquartersAddress: { country: 'US' },
      },
      registration: { status: 'ISSUED', initialRegistrationDate: '2018-01-01', lastUpdateDate: '2026-01-01' },
    },
  }],
};

test('CREDIT_SCORE_VERIFY happy path reports LEI registration, not a credit score', async (t) => {
  const base = startServer(t);
  stubGleif(t, SAMPLE_MATCH);
  const res = await fetch(`${base}/credit-score-verify?company=Apple`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.lei_registered, true);
  assert.equal(json.credit_score_available, false);
  assert.match(json.summary, /not a credit score/);
});

test('CREDIT_SCORE_VERIFY missing param refuses with 200, not 4xx', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/credit-score-verify`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('CREDIT_SCORE_VERIFY alias param "business" works', async (t) => {
  const base = startServer(t);
  stubGleif(t, { data: [] });
  const res = await fetch(`${base}/credit-score-verify?business=SomeObscureLLC`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.lei_registered, false);
});

test('CREDIT_SCORE_VERIFY question-shaped input extracts the company', async (t) => {
  const base = startServer(t);
  stubGleif(t, SAMPLE_MATCH);
  const res = await fetch(`${base}/credit-score-verify?question=${encodeURIComponent("What is Apple's credit score?")}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.lei_registered, true);
});

test('CREDIT_SCORE_VERIFY no match found is an honest ok answer, not a refusal', async (t) => {
  const base = startServer(t);
  stubGleif(t, { data: [] });
  const res = await fetch(`${base}/credit-score-verify?company=ZzzNonexistentCorp`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.matches.length, 0);
});

test('CREDIT_SCORE_VERIFY handles a 12,000+ char input without crashing', async (t) => {
  const base = startServer(t);
  stubGleif(t, { data: [] });
  const long = 'a'.repeat(12_500);
  const res = await fetch(`${base}/credit-score-verify?company=${encodeURIComponent(long)}`);
  assert.equal(res.status, 200);
});

test('CREDIT_SCORE_VERIFY upstream failure returns a real error code', async (t) => {
  const base = startServer(t);
  stubGleif(t, { status: 500, body: {} });
  const res = await fetch(`${base}/credit-score-verify?company=Apple`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.status, 'error');
});

test('CREDIT_SCORE_VERIFY POST works the same as GET', async (t) => {
  const base = startServer(t);
  stubGleif(t, SAMPLE_MATCH);
  const res = await fetch(`${base}/credit-score-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company: 'Apple' }),
  });
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

test('CREDIT_SCORE_VERIFY nonsense input refuses without crashing', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/credit-score-verify?company=${encodeURIComponent('???')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
});
