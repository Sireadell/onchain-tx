// Covers the SEC filings added to REGULATORY_FILING_MONITOR, the SEC fallback
// added to CORPORATE_REGISTRY_LOOKUP, and the central bank rates added to
// MACRO_ECONOMIC_INDICATOR. All outside services are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.SEC_LOOKUP_FORCE = '1';

const { forwardAsyncErrors, errorHandler } = await import('../app.js');
const { default: regulatoryRouter } = await import('./checkRegulatoryFilingMonitor.js');
const { default: registryRouter } = await import('./checkCorporateRegistry.js');
const { default: macroRouter } = await import('./checkMacroEconomicIndicator.js');
const { __clearFinancialCacheForTesting } = await import('../lib/financialData.js');
const { __clearRegulatoryCacheForTesting } = await import('../lib/regulatoryFilings.js');
const { __clearEntityRegistryCacheForTesting } = await import('../lib/entityRegistry.js');
const { __clearPolicyRatesCacheForTesting, parseEcbCsv, parseBoeCsv, parseBocJson, resolvePolicyRegion } = await import('../lib/policyRates.js');
const { __clearLoanRatesCacheForTesting } = await import('../lib/loanRates.js');
const { __clearMacroCacheForTesting } = await import('../lib/macroData.js');

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/regulatory-filing-monitor', forwardAsyncErrors(regulatoryRouter));
  app.use('/corporate-registry', forwardAsyncErrors(registryRouter));
  app.use('/macro-economic-indicator', forwardAsyncErrors(macroRouter));
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TICKERS = {
  0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
  1: { cik_str: 2098, ticker: 'UAMY', title: 'Acme United Corp' },
};

const APPLE = {
  name: 'Apple Inc.',
  cik: '0000320193',
  tickers: ['AAPL'],
  exchanges: ['Nasdaq'],
  entityType: 'operating',
  sic: '3571',
  sicDescription: 'Electronic Computers',
  stateOfIncorporation: 'CA',
  stateOfIncorporationDescription: 'CA',
  fiscalYearEnd: '0926',
  addresses: {
    business: { street1: 'ONE APPLE PARK WAY', city: 'CUPERTINO', stateOrCountry: 'CA', zipCode: '95014' },
    mailing: { street1: 'ONE APPLE PARK WAY', city: 'CUPERTINO', stateOrCountry: 'CA', zipCode: '95014' },
  },
  formerNames: [{ name: 'Apple Computer Inc', from: '1977-01-01', to: '2007-01-09' }],
  filings: {
    recent: {
      form: ['8-K', '10-K', '10-Q'],
      filingDate: ['2026-10-30', '2026-11-03', '2026-08-01'],
      accessionNumber: ['0000320193-26-000100', '0000320193-26-000106', '0000320193-26-000090'],
      primaryDocument: ['a8k.htm', 'aapl-10k.htm', 'aapl-10q.htm'],
      reportDate: ['2026-10-30', '2026-09-26', '2026-06-27'],
      primaryDocDescription: ['8-K', '10-K', '10-Q'],
      items: ['2.02', '', ''],
    },
  },
};

const FED_DOCS = {
  count: 1,
  results: [{ title: 'Apple Inc.; Notice of Application', type: 'Notice', abstract: 'An application.', agencies: [{ name: 'Securities and Exchange Commission' }], publication_date: '2026-01-02', html_url: 'https://example.test/doc', document_number: '2026-1' }],
};

const ECB_HEADER = 'KEY,FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE';
const NYFED = { refRates: [{ effectiveDate: '2026-11-02', type: 'EFFR', percentRate: 3.88, targetRateFrom: 3.75, targetRateTo: 4.0 }] };

function stubWorld(t, { fed = FED_DOCS, fedStatus = 200, secDown = false, gleif = { data: [] } } = {}) {
  [__clearFinancialCacheForTesting, __clearRegulatoryCacheForTesting, __clearEntityRegistryCacheForTesting, __clearPolicyRatesCacheForTesting, __clearLoanRatesCacheForTesting, __clearMacroCacheForTesting].forEach((f) => f());
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('federalregister.gov')) return json(fed, fedStatus);
    if (u.includes('sec.gov/files/company_tickers')) return secDown ? new Response('x', { status: 503 }) : json(TICKERS);
    if (u.includes('data.sec.gov/submissions/CIK0000320193')) return secDown ? new Response('x', { status: 503 }) : json(APPLE);
    if (u.includes('api.gleif.org')) return json(gleif);
    if (u.includes('newyorkfed.org')) return json(NYFED);
    if (u.includes('data-api.ecb.europa.eu')) {
      return new Response(`${ECB_HEADER}\nFM.X,B,U2,EUR,4F,KR,${u.includes('DFR') ? 'DFR' : 'MRR_FR'},LEV,2026-09-16,${u.includes('DFR') ? '2.50' : '2.65'}`, { status: 200 });
    }
    if (u.includes('bankofcanada.ca')) return json({ observations: [{ d: '2026-11-02', V39079: { v: '2.50' } }] });
    if (u.includes('bankofengland.co.uk')) return new Response('DATE,IUDBEDR\n15 Sep 2026,3.75\n16 Sep 2026,3.75\n', { status: 200 });
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
}

const get = async (base, path, qs) => (await fetch(`${base}${path}?${new URLSearchParams(qs)}`)).json();

// ---- Regulatory filings with SEC --------------------------------------------

test('a question about a company\'s 10-K is answered from its SEC filing', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const out = await get(base, '/regulatory-filing-monitor', { question: "What is Apple's latest 10-K filing?" });
  assert.equal(out.status, 'ok');
  assert.match(out.summary, /10-K for the period ending 2026-09-26, filed 2026-11-03/);
  assert.equal(out.sec_filings[0].url, 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000106/aapl-10k.htm');
  assert.match(out.source, /SEC EDGAR/);
  assert.equal(out.confidence, 0.9);
});

test('a plain company search keeps the Federal Register answer and adds the SEC filings as data', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const out = await get(base, '/regulatory-filing-monitor', { company: 'Apple' });
  assert.match(out.summary, /Federal Register filing for Apple/);
  assert.equal(out.source, 'Federal Register');
  assert.equal(out.sec_filings[0].form, '8-K');
  assert.equal(out.company.ticker, 'AAPL');
});

test('when the Federal Register has nothing, the SEC filing is the answer', async (t) => {
  const base = startServer(t);
  stubWorld(t, { fed: { count: 0, results: [] } });
  const out = await get(base, '/regulatory-filing-monitor', { company: 'Apple' });
  assert.match(out.summary, /most recent SEC filing from Apple Inc\. \(AAPL\) is a 8-K/);
});

test('the SEC filings still answer when the Federal Register is down', async (t) => {
  const base = startServer(t);
  stubWorld(t, { fedStatus: 500, fed: {} });
  const out = await get(base, '/regulatory-filing-monitor', { question: 'Show me the latest Apple SEC filings' });
  assert.equal(out.status, 'ok');
  assert.match(out.summary, /SEC filing from Apple/);
});

test('a subject that is not a company is unchanged and has no SEC data', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const out = await get(base, '/regulatory-filing-monitor', { company: 'Ioversol' });
  assert.equal(out.sec_filings, undefined);
  assert.equal(out.source, 'Federal Register');
});

// ---- Company registry with SEC fallback --------------------------------------

test('a company with no LEI record but an SEC record gets its SEC profile', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const out = await get(base, '/corporate-registry', { company: 'Apple Inc' });
  assert.equal(out.found, true);
  assert.equal(out.source, 'SEC EDGAR (data.sec.gov submissions)');
  assert.match(out.summary, /US SEC registrant \(CIK 320193, ticker AAPL\)/);
  assert.match(out.summary, /incorporated in CA/);
  assert.match(out.summary, /ONE APPLE PARK WAY, CUPERTINO, CA, 95014/);
  assert.match(out.summary, /formerly named Apple Computer Inc/);
});

test('a made-up company is still reported as not found, never matched loosely', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const out = await get(base, '/corporate-registry', { company: 'Acme Widgets Inc' });
  assert.equal(out.found, false);
  assert.match(out.summary, /No company named "Acme Widgets Inc"/);
});

// ---- Central bank rates -------------------------------------------------------

test('the Fed rate is the target range and the effective rate', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const out = await get(base, '/macro-economic-indicator', { question: 'What is the Fed interest rate?' });
  assert.equal(out.status, 'ok');
  assert.match(out.summary, /3\.75% to 4\.00%.*effective federal funds rate was 3\.88%/);
  assert.equal(out.value, 3.88);
});

test('the ECB answer gives the deposit and main refinancing rates', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const out = await get(base, '/macro-economic-indicator', { question: 'What is the ECB interest rate?' });
  assert.match(out.summary, /deposit facility rate is 2\.50%.*main refinancing rate is 2\.65%/);
  assert.equal(out.value, 2.5);
});

test('Canada and the UK are answered from their own central banks', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const ca = await get(base, '/macro-economic-indicator', { question: 'What is the Bank of Canada interest rate?' });
  assert.match(ca.summary, /overnight rate is 2\.50%/);
  const gb = await get(base, '/macro-economic-indicator', { question: 'What is the UK base rate?' });
  assert.match(gb.summary, /Bank Rate is 3\.75% as of 2026-09-16/);
});

test('an interest rate question with no supported central bank says which are covered', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const none = await get(base, '/macro-economic-indicator', { question: 'What is the interest rate?' });
  assert.equal(none.status, 'invalid_input');
  assert.match(none.summary, /the United States, the euro area, Canada, the United Kingdom/);
  const japan = await get(base, '/macro-economic-indicator', { question: 'What is the interest rate in Japan?' });
  assert.equal(japan.status, 'invalid_input');
});

test('GDP and inflation questions still go to the World Bank path', async (t) => {
  const base = startServer(t);
  stubWorld(t);
  const out = await get(base, '/macro-economic-indicator', { country: 'Japan' });
  assert.equal(out.status, 'invalid_input');
  assert.match(out.summary, /indicator/);
});

test('central bank files are read as the banks publish them', () => {
  assert.deepEqual(parseEcbCsv(`${ECB_HEADER}\nFM.X,B,U2,EUR,4F,KR,DFR,LEV,2026-09-16,2.50`), { date: '2026-09-16', percent: 2.5 });
  assert.deepEqual(parseBoeCsv('DATE,IUDBEDR\n15 Sep 2026,3.75\n16 Sep 2026,3.50\n'), { date: '2026-09-16', percent: 3.5 });
  assert.deepEqual(parseBocJson(JSON.stringify({ observations: [{ d: '2026-11-02', V39079: { v: '2.25' } }] })), { date: '2026-11-02', percent: 2.25 });
  assert.equal(resolvePolicyRegion('Germany interest rate'), 'EA');
  assert.equal(resolvePolicyRegion('give us the rate'), null);
  assert.equal(resolvePolicyRegion('US rate'), 'US');
});
