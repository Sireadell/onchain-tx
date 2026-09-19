import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import urlSafeRouter from './checkUrlSafe.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/url-safe', urlSafeRouter);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
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

function withoutSearchKey(t) {
  const prevT = process.env.TAVILY_API_KEY;
  const prevP = process.env.PERPLEXITY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (prevT !== undefined) process.env.TAVILY_API_KEY = prevT;
    if (prevP !== undefined) process.env.PERPLEXITY_API_KEY = prevP;
  });
}

test('url-safe: missing URL answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('url-safe: a clean URL with no detections is reported Safe', async (t) => {
  withoutSearchKey(t);
  stubFetch(t, (url) => {
    if (url.includes('urlhaus-api.abuse.ch')) {
      return new Response(JSON.stringify({
        query_status: 'ok',
        results: [{ threat: null, tags: [] }],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe?url=${encodeURIComponent('https://example.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'Safe');
  assert.equal(body.detection_count, 0);
});

test('url-safe: a URL with URLhaus malicious flag is reported Suspicious', async (t) => {
  withoutSearchKey(t);
  stubFetch(t, (url) => {
    if (url.includes('urlhaus-api.abuse.ch')) {
      return new Response(JSON.stringify({
        query_status: 'ok',
        results: [{
          threat: 'phishing',
          tags: ['phishing', 'credential-stealing'],
        }],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe?url=${encodeURIComponent('https://malicious.example.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'Suspicious');
  assert.equal(body.urlhaus_flagged, true);
});

test('url-safe: a URL embedded in a question is extracted', async (t) => {
  withoutSearchKey(t);
  stubFetch(t, (url) => {
    if (url.includes('urlhaus-api.abuse.ch')) {
      return new Response(JSON.stringify({
        query_status: 'ok',
        results: [{ threat: null, tags: [] }],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe?query=${encodeURIComponent('Is https://example.com safe?')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.query, 'https://example.com/');
});

test('url-safe: a bare domain with no scheme is treated as http', async (t) => {
  withoutSearchKey(t);
  stubFetch(t, (url) => {
    if (url.includes('urlhaus-api.abuse.ch')) {
      return new Response(JSON.stringify({
        query_status: 'ok',
        results: [{ threat: null, tags: [] }],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe?url=${encodeURIComponent('example.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.query, /example.com/);
});

test('url-safe: a private/internal address is refused, not checked', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe?url=${encodeURIComponent('http://192.168.1.1')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /private or internal/);
});

test('url-safe: localhost is refused, not checked', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe?url=${encodeURIComponent('http://localhost:8080')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
});

test('url-safe: not a valid URL at all is refused', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe?url=${encodeURIComponent('not a url at all')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
});

test('url-safe: URLhaus outage still allows answer using reputation check', async (t) => {
  const prevT = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tvly-test-key';
  t.after(() => {
    if (prevT !== undefined) process.env.TAVILY_API_KEY = prevT;
    else delete process.env.TAVILY_API_KEY;
  });
  stubFetch(t, (url) => {
    if (url.includes('urlhaus-api.abuse.ch')) return new Response('', { status: 500 });
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({
        answer: 'Safe. No reports of malicious activity found.',
        results: [],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe?url=${encodeURIComponent('https://example.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.urlhaus_flagged, null); // URLhaus not checked
});

test('url-safe: a 12000+ character input does not crash the route', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-safe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `not a url ${'x'.repeat(12500)}` }),
  });
  assert.equal(res.status, 200);
});
