import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkFinancialData.js';
import { __clearFinancialCacheForTesting, pickFact, METRICS, resolveCompany, resolveMetric, resolvePeriod, formatValue } from '../lib/financialData.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/financial-data', forwardAsyncErrors(router));
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const TICKERS = {
  0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  1: { cik_str: 1018724, ticker: 'AMZN', title: 'AMAZON COM INC' },
  2: { cik_str: 1326801, ticker: 'META', title: 'Meta Platforms, Inc.' },
  3: { cik_str: 1318605, ticker: 'TSLA', title: 'Tesla, Inc.' },
  4: { cik_str: 9999999, ticker: 'APLE', title: 'Apple Hospitality REIT, Inc.' },
};

const fy = (start, end, val, extra = {}) => ({ start, end, val, fy: Number(end.slice(0, 4)), fp: 'FY', form: '10-K', filed: `${end.slice(0, 4)}-11-01`, ...extra });
const q = (start, end, val) => ({ start, end, val, fy: 2025, fp: 'Q1', form: '10-Q', filed: '2025-02-01' });
const inst = (end, val) => ({ end, val, fy: Number(end.slice(0, 4)), fp: 'FY', form: '10-K', filed: `${end.slice(0, 4)}-11-01` });

// Apple moved its revenue to a newer tag in 2019, so the old tag is stale.
const CONCEPTS = {
  'CIK0000320193/us-gaap/Revenues': { USD: [fy('2017-10-01', '2018-09-29', 265595000000)] },
  'CIK0000320193/us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax': {
    USD: [
      fy('2022-09-25', '2023-09-30', 383285000000),
      fy('2023-10-01', '2024-09-28', 391035000000),
      q('2024-09-29', '2024-12-28', 124300000000),
      { ...fy('2023-10-01', '2024-09-28', 391035000000), filed: '2024-12-01' },
    ],
  },
  'CIK0000320193/us-gaap/NetIncomeLoss': { USD: [fy('2023-10-01', '2024-09-28', 93736000000)] },
  'CIK0000320193/us-gaap/Assets': { USD: [inst('2024-09-28', 364980000000)] },
  'CIK0000320193/us-gaap/StockholdersEquity': { USD: [inst('2024-09-28', 56950000000)] },
  'CIK0000320193/us-gaap/EarningsPerShareDiluted': { 'USD/shares': [fy('2023-10-01', '2024-09-28', 6.08)] },
  'CIK0001018724/us-gaap/NetIncomeLoss': { USD: [fy('2023-01-01', '2023-12-31', 30425000000)] },
};

function stubSec(t, { tickers = TICKERS, down = false } = {}) {
  __clearFinancialCacheForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('sec.gov/files/company_tickers')) {
      return down ? new Response('x', { status: 503 }) : new Response(JSON.stringify(tickers), { status: 200 });
    }
    if (u.includes('data.sec.gov/api/xbrl/companyconcept/')) {
      if (down) return new Response('x', { status: 503 });
      const key = u.split('companyconcept/')[1].replace(/\.json$/, '');
      return CONCEPTS[key] ? new Response(JSON.stringify({ units: CONCEPTS[key] }), { status: 200 }) : new Response('{}', { status: 404 });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearFinancialCacheForTesting(); });
}

const get = async (base, qs) => (await fetch(`${base}/financial-data?${new URLSearchParams(qs)}`)).json();

test('FINANCIAL_DATA answers revenue from the newest tag, not a stale one', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { company: 'Apple', metric: 'revenue' });
  assert.equal(json.status, 'ok');
  assert.equal(json.ticker, 'AAPL');
  assert.equal(json.value, 391035000000);
  assert.equal(json.period_end, '2024-09-28');
  assert.match(json.summary, /\$391\.04 billion/);
  assert.match(json.summary, /10-K filed 2024-12-01/);
});

test('FINANCIAL_DATA reads company and metric out of a whole question', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { question: "What was Apple's net income last year?" });
  assert.equal(json.metric, 'net_income');
  assert.equal(json.value, 93736000000);
});

test('FINANCIAL_DATA picks the quarterly figure when the question says quarter', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { question: "What was Apple's latest quarterly revenue?" });
  assert.equal(json.period, 'quarter');
  assert.equal(json.value, 124300000000);
  assert.match(json.summary, /quarter ended 2024-12-28/);
});

test('FINANCIAL_DATA formats earnings per share per share', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { company: 'AAPL', metric: 'EPS' });
  assert.equal(json.value, 6.08);
  assert.match(json.summary, /\$6\.08 per share/);
});

test('FINANCIAL_DATA gives a short snapshot when no metric is named', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { company: 'Apple Inc' });
  assert.equal(json.metric, 'snapshot');
  assert.deepEqual(json.figures.map((f) => f.metric), ['revenue', 'net_income', 'total_assets', 'equity']);
  assert.match(json.summary, /total assets \$364\.98 billion/);
});

test('FINANCIAL_DATA matches a casual name to the formal SEC name', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { company: 'amazon', metric: 'net income' });
  assert.equal(json.ticker, 'AMZN');
  assert.equal(json.value, 30425000000);
});

test('FINANCIAL_DATA says so when a company has no such figure', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { company: 'Tesla', metric: 'revenue' });
  assert.equal(json.status, 'not_found');
  assert.match(json.summary, /Tesla/);
});

test('FINANCIAL_DATA does not guess a company that does not file with the SEC', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { company: 'Zzyzx Holdings Pty' });
  assert.equal(json.status, 'not_found');
  assert.match(json.summary, /No US SEC filer/);
});

test('FINANCIAL_DATA asks for a company when none is given', async (t) => {
  const base = startServer(t);
  stubSec(t);
  const json = await get(base, { metric: 'revenue' });
  assert.equal(json.status, 'invalid_input');
});

test('FINANCIAL_DATA reports an error when EDGAR is down', async (t) => {
  const base = startServer(t);
  stubSec(t, { down: true });
  const res = await fetch(`${base}/financial-data?company=Apple`);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).status, 'error');
});

test('pickFact ignores spans that are not a full year and prefers the latest re-filing', () => {
  const facts = [
    fy('2023-10-01', '2024-09-28', 1),
    { ...fy('2023-10-01', '2024-09-28', 2), filed: '2025-01-01' },
    fy('2024-04-01', '2024-09-28', 3),
  ];
  assert.equal(pickFact(facts, METRICS.revenue, 'annual').val, 2);
});

test('company, metric and period words are read from questions', async (t) => {
  stubSec(t);
  assert.equal((await resolveCompany('What was the total revenue of Apple?')).ticker, 'AAPL');
  assert.equal((await resolveCompany('How is Meta doing on profit?')).ticker, 'META');
  assert.equal((await resolveCompany('what is the total revenue this year')), null);
  assert.equal((await resolveCompany('$TSLA')).ticker, 'TSLA');
  assert.equal(resolveMetric('operating profit'), 'operating_income');
  assert.equal(resolveMetric('earnings per share'), 'eps');
  assert.equal(resolveMetric('how big is the company'), null);
  assert.equal(resolvePeriod('Q3 results'), 'quarter');
  assert.equal(formatValue(-2500000, 'USD'), '-$2.50 million');
});
