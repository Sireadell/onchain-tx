import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import carrierServiceabilityRouter from './checkCarrierServiceability.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/carrier-serviceability', carrierServiceabilityRouter);
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

function withNoKeys(t) {
  const prevT = process.env.TAVILY_API_KEY;
  const prevP = process.env.PERPLEXITY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (prevT !== undefined) process.env.TAVILY_API_KEY = prevT;
    if (prevP !== undefined) process.env.PERPLEXITY_API_KEY = prevP;
  });
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const stubbed = await handler(String(url), init, original);
    if (stubbed !== undefined) return stubbed;
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
}

test('carrier-serviceability: missing address answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/carrier-serviceability`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('carrier-serviceability: happy path reports coverage from web search', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({
        answer: 'UPS delivers to ZIP code 10001 with standard ground and next-day service available.',
        results: [{ title: 'UPS Service Map', url: 'https://example.com/ups', content: 'x', score: 0.9 }],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/carrier-serviceability?address=${encodeURIComponent('10001')}&carrier=ups`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.carrier, 'ups');
  assert.match(body.summary, /UPS/);
});

test('carrier-serviceability: alias params (zip, question) are accepted', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: 'FedEx serves this ZIP.', results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/carrier-serviceability?zip=90210&question=Does fedex deliver here`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
});

test('carrier-serviceability: nonsense input still answers 200 honestly when no answer found', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: null, results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/carrier-serviceability?address=${encodeURIComponent('asdkjhaksjdh zzzz')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
});

test('carrier-serviceability: no provider configured answers 503', async (t) => {
  withNoKeys(t);
  const base = startServer(t);
  const res = await fetch(`${base}/carrier-serviceability?address=10001`);
  assert.equal(res.status, 503);
});

test('carrier-serviceability: a 12,000+ char input is handled without crashing', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: 'Serviceable.', results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const huge = 'a'.repeat(12_500);
  const res = await fetch(`${base}/carrier-serviceability?address=${encodeURIComponent(huge)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.query.length <= 500);
});

test('carrier-serviceability: provider failure returns 502, not a crash', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) return new Response('', { status: 500 });
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/carrier-serviceability?address=10001`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.status, 'error');
});
