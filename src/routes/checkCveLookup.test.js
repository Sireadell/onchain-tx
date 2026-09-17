import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { __clearCveCacheForTesting, extractCveId, severityFromScore } from '../lib/cveLookup.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

// Stubs both CVE sources. `circl` and `nvd` are either a body (served with
// HTTP 200), or { status, body } to force a failure code. Calls are
// recorded per source so a test can assert which source was spent.
function stubSources(t, { circl, nvd } = {}) {
  __clearCveCacheForTesting();
  const original = globalThis.fetch;
  const calls = { circl: [], nvd: [] };
  const serve = (spec) => {
    const status = spec && typeof spec === 'object' && 'status' in spec && 'body' in spec ? spec.status : 200;
    const body = spec && typeof spec === 'object' && 'status' in spec && 'body' in spec ? spec.body : spec;
    return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json' } });
  };
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://cve.circl.lu')) {
      calls.circl.push(str);
      return serve(circl);
    }
    if (str.startsWith('https://services.nvd.nist.gov')) {
      calls.nvd.push(str);
      return serve(nvd);
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearCveCacheForTesting(); });
  return calls;
}

// A trimmed CVE JSON 5.1 record, the shape cve.circl.lu serves.
const CIRCL_LOG4SHELL = {
  dataType: 'CVE_RECORD',
  cveMetadata: { cveId: 'CVE-2021-44228', state: 'PUBLISHED', datePublished: '2021-12-10T00:00:00.000Z', dateUpdated: '2025-10-21T23:25:23.121Z' },
  containers: {
    cna: {
      title: 'Apache Log4j2 JNDI features do not protect against attacker controlled LDAP',
      descriptions: [{ lang: 'en', value: 'Apache Log4j2 2.0-beta9 through 2.15.0 JNDI features do not protect against attacker controlled LDAP. An attacker who can control log messages can execute arbitrary code.' }],
      affected: [{ vendor: 'Apache Software Foundation', product: 'Apache Log4j2', versions: [{ version: '2.0-beta9', status: 'affected', lessThan: '2.15.0' }] }],
      problemTypes: [{ descriptions: [{ cweId: 'CWE-502', description: 'CWE-502 Deserialization of Untrusted Data' }] }],
      metrics: [{ other: { type: 'unknown', content: { other: 'critical' } } }],
      references: [{ url: 'https://logging.apache.org/log4j/2.x/security.html' }],
    },
    adp: [{
      title: 'CISA ADP Vulnrichment',
      metrics: [
        { cvssV3_1: { version: '3.1', baseScore: 10, baseSeverity: 'CRITICAL', vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H' } },
        { other: { type: 'ssvc', content: { options: [{ Exploitation: 'active' }] } } },
        { other: { type: 'kev', content: { dateAdded: '2021-12-10' } } },
      ],
    }],
  },
};

// The same CVE as NVD serves it.
const NVD_LOG4SHELL = {
  totalResults: 1,
  vulnerabilities: [{
    cve: {
      id: 'CVE-2021-44228',
      vulnStatus: 'Analyzed',
      published: '2021-12-10T10:15:00.000',
      lastModified: '2023-11-07T03:33:00.000',
      descriptions: [{ lang: 'en', value: 'Apache Log4j2 JNDI features do not protect against attacker controlled LDAP.' }],
      metrics: { cvssMetricV31: [{ cvssData: { version: '3.1', baseScore: 10.0, baseSeverity: 'CRITICAL', vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H' } }] },
      references: [{ url: 'https://logging.apache.org/log4j/2.x/security.html' }],
    },
  }],
};

// An old CVE as CIRCL serves it: description, no score of any kind.
const CIRCL_OLD_NO_SCORE = {
  cveMetadata: { cveId: 'CVE-2010-0001', state: 'PUBLISHED', datePublished: '2010-01-15T00:00:00.000Z' },
  containers: {
    cna: {
      descriptions: [{ lang: 'en', value: 'Integer underflow in the unlzw function in gzip before 1.4 allows remote attackers to cause a denial of service.' }],
      affected: [{ vendor: 'n/a', product: 'n/a', versions: [{ version: 'n/a', status: 'affected' }] }],
    },
    adp: [{ title: 'CVE Program Container' }],
  },
};

const NVD_OLD = {
  totalResults: 1,
  vulnerabilities: [{
    cve: {
      id: 'CVE-2010-0001',
      vulnStatus: 'Modified',
      published: '2010-01-15T18:30:00.000',
      descriptions: [{ lang: 'en', value: 'Integer underflow in the unlzw function in gzip before 1.4.' }],
      metrics: { cvssMetricV2: [{ baseSeverity: 'MEDIUM', cvssData: { version: '2.0', baseScore: 6.8, vectorString: 'AV:N/AC:M/Au:N/C:P/I:P/A:P' } }] },
    },
  }],
};

test('cve-lookup: extractCveId finds the id however it is written, and never a bare year', () => {
  assert.equal(extractCveId('CVE-2021-44228'), 'CVE-2021-44228');
  assert.equal(extractCveId('cve 2021 44228'), 'CVE-2021-44228');
  assert.equal(extractCveId('Look up CVE_2024_3094 and report severity'), 'CVE-2024-3094');
  assert.equal(extractCveId('Is on-chain transaction CVE-2021-44228 successful?'), 'CVE-2021-44228');
  assert.equal(extractCveId('CVE 2015'), null);
  assert.equal(extractCveId('Criticial CVE 2025'), null);
  assert.equal(extractCveId('CVE'), null);
});

test('cve-lookup: severityFromScore uses the CVSS v3 bands', () => {
  assert.equal(severityFromScore(10), 'CRITICAL');
  assert.equal(severityFromScore(7.5), 'HIGH');
  assert.equal(severityFromScore(5), 'MEDIUM');
  assert.equal(severityFromScore(2), 'LOW');
  assert.equal(severityFromScore(null), null);
});

test('cve-lookup: missing cve id answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('cve-lookup: answers from CIRCL first and leads with id, severity and score', async (t) => {
  const calls = stubSources(t, { circl: CIRCL_LOG4SHELL, nvd: NVD_LOG4SHELL });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=CVE-2021-44228`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.cve_id, 'CVE-2021-44228');
  assert.equal(body.severity, 'CRITICAL');
  assert.equal(body.cvss_score, 10);
  assert.equal(body.known_exploited, true);
  assert.match(body.summary, /^CVE-2021-44228 is rated CRITICAL with a CVSS 3\.1 base score of 10\.0\./);
  assert.match(body.summary, /Apache Log4j2/);
  assert.match(body.summary, /Known Exploited Vulnerabilities/);
  assert.match(body.attribution, /CIRCL/);
  assert.equal(calls.circl.length, 1);
  // A complete CIRCL record must not spend a rate-limited NVD call.
  assert.equal(calls.nvd.length, 0);
});

test('cve-lookup: a whole question containing the id is answered, not refused', async (t) => {
  stubSources(t, { circl: CIRCL_LOG4SHELL });
  const base = startServer(t);
  const q = 'Look up this CVE identifier and report its severity (LOW/MEDIUM/HIGH/CRITICAL) and CVSS score: CVE-2021-44228';
  const res = await fetch(`${base}/cve-lookup?cve=${encodeURIComponent(q)}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.cve_id, 'CVE-2021-44228');
});

test('cve-lookup: accepts the aliases competing miners declare', async (t) => {
  stubSources(t, { circl: CIRCL_LOG4SHELL });
  const base = startServer(t);
  for (const key of ['cve_id', 'cveId', 'id', 'vulnerability', 'query', 'q', 'question', 'keyword']) {
    const res = await fetch(`${base}/cve-lookup?${key}=CVE-2021-44228`);
    const body = await res.json();
    assert.equal(body.status, 'ok', `${key} was not accepted`);
    assert.equal(body.cve_id, 'CVE-2021-44228');
  }
});

test('cve-lookup: lowercase and space-separated ids resolve', async (t) => {
  stubSources(t, { circl: CIRCL_LOG4SHELL });
  const base = startServer(t);
  for (const value of ['cve-2021-44228', 'CVE 2021 44228']) {
    const res = await fetch(`${base}/cve-lookup?cve=${encodeURIComponent(value)}`);
    assert.equal((await res.json()).cve_id, 'CVE-2021-44228', `${value} did not resolve`);
  }
});

test('cve-lookup: an NVD rate limit is not a failure while CIRCL answers', async (t) => {
  const previous = process.env.NVD_API_KEY;
  process.env.NVD_API_KEY = 'test-key';
  t.after(() => { if (previous === undefined) delete process.env.NVD_API_KEY; else process.env.NVD_API_KEY = previous; });
  const calls = stubSources(t, { circl: CIRCL_LOG4SHELL, nvd: { status: 429, body: {} } });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=CVE-2021-44228`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.cvss_score, 10);
  assert.equal(body.degraded, true);
  assert.equal(calls.nvd.length, 1);
  assert.equal(calls.circl.length, 1);
});

test('cve-lookup: an unscored CIRCL record borrows the score from NVD', async (t) => {
  const calls = stubSources(t, { circl: CIRCL_OLD_NO_SCORE, nvd: NVD_OLD });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=CVE-2010-0001`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.severity, 'MEDIUM');
  assert.equal(body.cvss_score, 6.8);
  assert.match(body.summary, /^CVE-2010-0001 is rated MEDIUM with a CVSS 2\.0 base score of 6\.8\./);
  assert.ok(!/n\/a/.test(body.summary), 'placeholder product leaked into the sentence');
  assert.equal(calls.nvd.length, 1);
});

test('cve-lookup: an unscored record with NVD rate-limited still answers from the description', async (t) => {
  stubSources(t, { circl: CIRCL_OLD_NO_SCORE, nvd: { status: 403, body: {} } });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=CVE-2010-0001`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /no CVSS score assigned yet/);
  assert.match(body.summary, /Integer underflow/);
});

test('cve-lookup: a repeat question is served from cache without a network call', async (t) => {
  const calls = stubSources(t, { circl: CIRCL_LOG4SHELL });
  const base = startServer(t);
  await fetch(`${base}/cve-lookup?cve=CVE-2021-44228`);
  await fetch(`${base}/cve-lookup?cve_id=CVE-2021-44228`);
  await fetch(`${base}/cve-lookup?question=${encodeURIComponent('What is CVE-2021-44228?')}`);
  assert.equal(calls.circl.length, 1);
});

test('cve-lookup: an unknown id is an honest answer, not a failure', async (t) => {
  stubSources(t, { circl: {}, nvd: { totalResults: 0, vulnerabilities: [] } });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=CVE-9999-99999`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /CVE-9999-99999 is not in the CVE registry/);
});

test('cve-lookup: both sources down is the one real 502', async (t) => {
  stubSources(t, { circl: { status: 503, body: {} }, nvd: { status: 429, body: {} } });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=CVE-2021-44228`);
  assert.equal(res.status, 502);
});

test('cve-lookup: a keyword search hits the NVD keyword index and ranks by severity', async (t) => {
  const calls = stubSources(t, { nvd: NVD_LOG4SHELL });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=log4j`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(calls.nvd[0], /keywordSearch=log4j/);
  assert.match(body.summary, /1 CVE record match "log4j"\. The most severe is CVE-2021-44228, rated CRITICAL \(CVSS 10\.0\)/);
});

test('cve-lookup: "known vulnerabilities in log4j" searches for log4j, not the sentence', async (t) => {
  const calls = stubSources(t, { nvd: NVD_LOG4SHELL });
  const base = startServer(t);
  await fetch(`${base}/cve-lookup?cve=${encodeURIComponent('known vulnerabilities in log4j')}`);
  assert.match(calls.nvd[0], /keywordSearch=log4j&/);
});

test('cve-lookup: a rate-limited keyword search is a 200 with guidance, not a 502', async (t) => {
  stubSources(t, { nvd: { status: 403, body: {} } });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=log4j`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /rate-limited/);
});

test('cve-lookup: an unrelated question is answered honestly without spending a lookup', async (t) => {
  const calls = stubSources(t, { nvd: NVD_LOG4SHELL, circl: CIRCL_LOG4SHELL });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=${encodeURIComponent('Will Infacort receive FDA approval?')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /does not name a CVE id/);
  assert.equal(calls.nvd.length + calls.circl.length, 0);
});

test('cve-lookup: a year or a bare "CVE" is answered honestly without a search', async (t) => {
  const calls = stubSources(t, { nvd: NVD_LOG4SHELL });
  const base = startServer(t);
  for (const value of ['CVE', 'CVE 2015', 'Criticial CVE 2025', 'CVEs 2010 high priority']) {
    const res = await fetch(`${base}/cve-lookup?cve=${encodeURIComponent(value)}`);
    assert.equal(res.status, 200, value);
    assert.equal((await res.json()).status, 'invalid_input', value);
  }
  assert.equal(calls.nvd.length, 0);
});

test('cve-lookup: a 5k-character value is capped, answered, and never forwarded whole', async (t) => {
  const calls = stubSources(t, { nvd: NVD_LOG4SHELL, circl: CIRCL_LOG4SHELL });
  const base = startServer(t);
  const res = await fetch(`${base}/cve-lookup?cve=${'x'.repeat(5000)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.summary.length < 400);
  for (const url of calls.nvd) assert.ok(url.length < 600, 'huge value forwarded to NVD');
});
