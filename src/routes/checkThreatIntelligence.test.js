import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import threatIntelligenceRouter from './checkThreatIntelligence.js';
import { __clearCveCacheForTesting } from '../lib/cveLookup.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/threat-intelligence', threatIntelligenceRouter);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function withKey(t, value = 'tvly-test-key') {
  const previous = process.env.TAVILY_API_KEY;
  if (value) process.env.TAVILY_API_KEY = value;
  else delete process.env.TAVILY_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  });
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const stubbed = await handler(String(url), init, original);
    if (stubbed !== undefined) return stubbed;
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('threat-intelligence: missing indicator answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('threat-intelligence: a malicious IP is reported from OTX pulse data', async (t) => {
  stubFetch(t, (url) => {
    if (url.includes('otx.alienvault.com/api/v1/indicators/IPv4/')) {
      return new Response(JSON.stringify({
        indicator: '1.2.3.4',
        reputation: -20,
        pulse_info: { count: 3, pulses: [{ name: 'Known botnet C2' }] },
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence?indicator=1.2.3.4`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.malicious, true);
  assert.equal(body.pulse_count, 3);
  assert.match(body.summary, /flagged as a known threat/);
});

test('threat-intelligence: a clean domain reports no known malicious activity', async (t) => {
  stubFetch(t, (url) => {
    if (url.includes('otx.alienvault.com/api/v1/indicators/hostname/')) {
      return new Response(JSON.stringify({ indicator: 'example.com', reputation: 0, pulse_info: { count: 0, pulses: [] } }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence?indicator=example.com`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.malicious, false);
  assert.match(body.summary, /no known malicious activity/);
});

test('threat-intelligence: a file hash is looked up as a file indicator', async (t) => {
  const calls = stubFetch(t, (url) => {
    if (url.includes('otx.alienvault.com/api/v1/indicators/file/')) {
      return new Response(JSON.stringify({ indicator: 'x', pulse_info: { count: 1, pulses: [{ name: 'Emotet dropper' }] } }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence?indicator=44d88612fea8a8f36de82e1278abb02f`);
  const body = await res.json();
  assert.equal(body.malicious, true);
  assert.equal(body.indicator_type, 'hash');
  assert.ok(calls.some((c) => c.includes('/file/44d88612fea8a8f36de82e1278abb02f/')));
});

test('threat-intelligence: a CVE id is answered from CIRCL/NVD, not OTX', async (t) => {
  __clearCveCacheForTesting();
  stubFetch(t, (url) => {
    if (url.includes('cve.circl.lu')) {
      return new Response(JSON.stringify({
        cveMetadata: { cveId: 'CVE-2021-44228' },
        containers: {
          cna: {
            descriptions: [{ lang: 'en', value: 'Apache Log4j2 JNDI RCE vulnerability.' }],
            metrics: [{ cvssV3_1: { baseScore: 10.0, baseSeverity: 'CRITICAL', vectorString: 'AV:N', version: '3.1' } }],
          },
        },
      }), { status: 200 });
    }
    if (url.includes('kev') || url.includes('cisa.gov')) return new Response(JSON.stringify({ vulnerabilities: [] }), { status: 200 });
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence?indicator=CVE-2021-44228`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.indicator_type, 'cve');
  assert.equal(body.source, 'CIRCL / NVD');
});

test('threat-intelligence: an actor name with no indicator shape falls back to web search', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({
        answer: 'Lazarus Group is a North Korea-linked APT known for financial theft and cryptocurrency heists.',
        results: [{ title: 'Lazarus Group - CISA', url: 'https://example.com/lazarus', content: 'x', score: 0.9 }],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence?indicator=${encodeURIComponent('Lazarus Group')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.source, 'web search');
  assert.match(body.summary, /Lazarus/);
});

test('threat-intelligence: OTX outage falls back to web search rather than failing the question', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.includes('otx.alienvault.com')) return new Response('', { status: 500 });
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: 'No known malicious activity is documented for this IP.', results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence?indicator=9.9.9.9`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.source, 'web search');
});

test('threat-intelligence: nonsense input with no substance is refused', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence?indicator=${encodeURIComponent('????')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('threat-intelligence: a 12000+ character input does not crash the route', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) return new Response(JSON.stringify({ answer: 'An answer.', results: [] }), { status: 200 });
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ indicator: 'a'.repeat(12500) }),
  });
  assert.equal(res.status, 200);
});

test('threat-intelligence: no search provider configured for the fallback path answers 503', async (t) => {
  const previous = process.env.TAVILY_API_KEY;
  const previousP = process.env.PERPLEXITY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.TAVILY_API_KEY = previous;
    if (previousP !== undefined) process.env.PERPLEXITY_API_KEY = previousP;
  });
  stubFetch(t, (url) => {
    if (url.includes('otx.alienvault.com')) return new Response('', { status: 500 });
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/threat-intelligence?indicator=9.9.9.9`);
  assert.equal(res.status, 503);
});
