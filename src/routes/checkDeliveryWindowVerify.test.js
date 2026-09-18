import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import deliveryWindowVerifyRouter from './checkDeliveryWindowVerify.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/delivery-window-verify', deliveryWindowVerifyRouter);
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

test('delivery-window-verify: missing route answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/delivery-window-verify`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('delivery-window-verify: happy path with origin/destination gives a caveated estimate', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({
        answer: 'UPS Ground from New York to Los Angeles typically takes 4 to 5 business days.',
        results: [{ title: 'UPS Transit Times', url: 'https://example.com/ups-transit', content: 'x', score: 0.9 }],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/delivery-window-verify?origin=New York&destination=Los Angeles&carrier=ups&service=ground`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.is_estimate, true);
  assert.match(body.summary, /estimate/);
});

test('delivery-window-verify: alias params (route, question) are accepted', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: 'Typically 3 to 4 days.', results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/delivery-window-verify?question=How long does FedEx express take from Chicago to Miami`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
});

test('delivery-window-verify: nonsense input answers 200 honestly when no answer found', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: null, results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/delivery-window-verify?route=${encodeURIComponent('zzz qqqq nonsense')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
});

test('delivery-window-verify: no provider configured answers 503', async (t) => {
  withNoKeys(t);
  const base = startServer(t);
  const res = await fetch(`${base}/delivery-window-verify?route=NY to LA`);
  assert.equal(res.status, 503);
});

test('delivery-window-verify: a 12,000+ char input is handled without crashing', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: 'About 5 days.', results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const huge = 'a'.repeat(12_500);
  const res = await fetch(`${base}/delivery-window-verify?route=${encodeURIComponent(huge)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.query.length <= 500);
});

test('delivery-window-verify: provider failure returns 502, not a crash', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) return new Response('', { status: 500 });
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/delivery-window-verify?route=NY to LA`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.status, 'error');
});
