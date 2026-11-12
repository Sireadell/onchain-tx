import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkLoanInterestRateQuote.js';
import { __clearLoanRatesCacheForTesting, parsePmms, resolveLoanType } from '../lib/loanRates.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/loan-interest-rate-quote', forwardAsyncErrors(router));
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const PMMS_CSV = [
  'date,pmms30,pmms30p,pmms15,pmms15p,pmms51,pmms51p,pmms51m,pmms51spread',
  '10/22/2026,6.19, ,5.40, ,,,,',
  '10/29/2026,6.23, ,5.45, ,,,,',
].join('\n');
const NYFED = { refRates: [{ effectiveDate: '2026-11-02', type: 'EFFR', percentRate: 3.88, targetRateFrom: 3.75, targetRateTo: 4.0 }] };

function stubSources(t, { pmms = { status: 200, body: PMMS_CSV }, nyfed = { status: 200, body: JSON.stringify(NYFED) } } = {}) {
  __clearLoanRatesCacheForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('freddiemac.com')) return new Response(pmms.body, { status: pmms.status });
    if (u.includes('newyorkfed.org')) return new Response(nyfed.body, { status: nyfed.status });
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearLoanRatesCacheForTesting(); });
}

test('LOAN_INTEREST_RATE_QUOTE answers the 30-year mortgage by default, with the change and the prime rate', async (t) => {
  const base = startServer(t);
  stubSources(t);
  const json = await (await fetch(`${base}/loan-interest-rate-quote`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.loan_type, 'mortgage_30y');
  assert.equal(json.rate_percent, 6.23);
  assert.equal(json.week_change, 0.04);
  assert.equal(json.as_of, '2026-10-29');
  assert.equal(json.rates.prime_percent, 7);
  assert.match(json.summary, /6\.23%/);
  assert.match(json.summary, /up 0\.04 points/);
});

test('LOAN_INTEREST_RATE_QUOTE prime rate is the top of the Fed range plus 3', async (t) => {
  const base = startServer(t);
  stubSources(t);
  const json = await (await fetch(`${base}/loan-interest-rate-quote?question=${encodeURIComponent('What is the current prime rate?')}`)).json();
  assert.equal(json.loan_type, 'prime');
  assert.equal(json.rate_percent, 7);
  assert.deepEqual(json.fed_target_range, { from: 3.75, to: 4 });
  assert.match(json.summary, /3\.75% to 4\.00%/);
});

test('LOAN_INTEREST_RATE_QUOTE picks the 15-year mortgage from a loan_type param', async (t) => {
  const base = startServer(t);
  stubSources(t);
  const json = await (await fetch(`${base}/loan-interest-rate-quote?loan_type=15-year%20fixed`)).json();
  assert.equal(json.loan_type, 'mortgage_15y');
  assert.equal(json.rate_percent, 5.45);
});

test('LOAN_INTEREST_RATE_QUOTE says so plainly when a 5/1 ARM is asked for but not published', async (t) => {
  const base = startServer(t);
  stubSources(t);
  const json = await (await fetch(`${base}/loan-interest-rate-quote?loan_type=5/1%20ARM`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.loan_type, 'mortgage_30y');
  assert.match(json.summary, /no longer published/);
});

test('LOAN_INTEREST_RATE_QUOTE does not guess personal loan rates', async (t) => {
  const base = startServer(t);
  stubSources(t);
  const json = await (await fetch(`${base}/loan-interest-rate-quote?question=${encodeURIComponent('What is the average personal loan rate?')}`)).json();
  assert.equal(json.status, 'invalid_input');
  assert.match(json.summary, /personal loan/);
});

test('LOAN_INTEREST_RATE_QUOTE still answers a mortgage question when the prime source is down', async (t) => {
  const base = startServer(t);
  stubSources(t, { nyfed: { status: 500, body: '{}' } });
  const json = await (await fetch(`${base}/loan-interest-rate-quote`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.rates.prime_percent, null);
});

test('LOAN_INTEREST_RATE_QUOTE says unavailable, never a 5xx, when the source it needs is down', async (t) => {
  const base = startServer(t);
  stubSources(t, { pmms: { status: 503, body: 'down' } });
  const res = await fetch(`${base}/loan-interest-rate-quote`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'unavailable');
  assert.equal(json.rate_percent, null);
});

test('loan type words are read from natural questions', () => {
  assert.equal(resolveLoanType('what is the 30 year fixed mortgage rate'), 'mortgage_30y');
  assert.equal(resolveLoanType('mortgage rates today'), 'mortgage_30y');
  assert.equal(resolveLoanType('15yr mortgage'), 'mortgage_15y');
  assert.equal(resolveLoanType('prime lending rate'), 'prime');
  assert.equal(resolveLoanType('loan interest rate'), null);
});

test('parsePmms reads the latest week and the change from the week before', () => {
  const out = parsePmms(PMMS_CSV);
  assert.equal(out.mortgage_30y.percent, 6.23);
  assert.equal(out.mortgage_15y.week_change, 0.05);
  assert.equal(out.arm_5_1, null);
});

test('LOAN_INTEREST_RATE_QUOTE answers the survey week of a named past date and gives year context', async (t) => {
  const base = startServer(t);
  const rows = ['date,pmms30,pmms30p,pmms15,pmms15p,pmms51,pmms51p,pmms51m,pmms51spread'];
  let d = Date.UTC(2023, 9, 5);
  for (let i = 0; i < 160; i += 1) {
    const dt = new Date(d + i * 7 * 86_400_000);
    rows.push(`${dt.getUTCMonth() + 1}/${dt.getUTCDate()}/${dt.getUTCFullYear()},${(6 + i / 100).toFixed(2)}, ,5.40, ,,,,`);
  }
  stubSources(t, { pmms: { status: 200, body: rows.join('\n') } });
  const q = 'What is the current average APR for a 30-year fixed-rate mortgage in California as of today, October 26, 2023?';
  const json = await (await fetch(`${base}/loan-interest-rate-quote?query=${encodeURIComponent(q)}`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.requested_week.week, '2023-10-26');
  assert.equal(json.requested_week.percent, 6.03);
  assert.match(json.summary, /^For the survey week of 2023-10-26/);
  assert.match(json.summary, /A year earlier, in the week of/);
  assert.match(json.summary, /no separate California figure/);
  assert.match(json.summary, /not an APR/);
});
