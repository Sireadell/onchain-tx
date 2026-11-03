import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import returnPolicyVerifyRouter from './checkReturnPolicyVerify.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/return-policy-verify', returnPolicyVerifyRouter);
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
  const previousP = process.env.PERPLEXITY_API_KEY;
  if (value) process.env.TAVILY_API_KEY = value;
  else delete process.env.TAVILY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
    if (previousP !== undefined) process.env.PERPLEXITY_API_KEY = previousP;
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

test('return-policy-verify: missing retailer answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/return-policy-verify`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('return-policy-verify: a named retailer returns its policy from web search', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({
        answer: 'Target allows returns within 90 days with a receipt; most items must be unused and in original packaging.',
        results: [{ title: 'Target Return Policy', url: 'https://example.com/target-returns', content: 'x', score: 0.9 }],
      }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/return-policy-verify?retailer=Target`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.verified, true);
  assert.match(body.summary, /Target/);
});

test('return-policy-verify: alias params (store) and a whole question are both accepted', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: 'A 30-day return window applies.', results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res1 = await fetch(`${base}/return-policy-verify?store=Best Buy`);
  assert.equal((await res1.json()).status, 'ok');
  const res2 = await fetch(`${base}/return-policy-verify?question=${encodeURIComponent("What is Walmart's return policy for electronics?")}`);
  const body2 = await res2.json();
  assert.equal(body2.status, 'ok');
  assert.match(body2.retailer, /Walmart/);
});

test('return-policy-verify: nonsense input with no substance is refused', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/return-policy-verify?retailer=${encodeURIComponent('????')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('return-policy-verify: no policy found is answered honestly, not fabricated', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: null, results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/return-policy-verify?retailer=${encodeURIComponent('Some Obscure Local Shop XYZ')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.verified, false);
  assert.match(body.summary, /No verifiable return policy/);
});

test('return-policy-verify: a 12000+ character input does not crash the route', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) return new Response(JSON.stringify({ answer: 'An answer.', results: [] }), { status: 200 });
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/return-policy-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ retailer: 'a'.repeat(12500) }),
  });
  assert.equal(res.status, 200);
});

test('return-policy-verify: upstream outage answers 502, not a crash', async (t) => {
  withKey(t);
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) return new Response('', { status: 500 });
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/return-policy-verify?retailer=Nike`);
  assert.equal(res.status, 502);
});

test('return-policy-verify: no search provider configured answers 503', async (t) => {
  const previous = process.env.TAVILY_API_KEY;
  const previousP = process.env.PERPLEXITY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.TAVILY_API_KEY = previous;
    if (previousP !== undefined) process.env.PERPLEXITY_API_KEY = previousP;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/return-policy-verify?retailer=Nike`);
  assert.equal(res.status, 503);
});

test('return-policy-verify: a question with no retailer is searched as asked', async (t) => {
  withKey(t);
  let sent = '';
  stubFetch(t, (url, init) => {
    if (url.startsWith('https://api.tavily.com')) {
      sent = String(init?.body ?? '');
      return new Response(JSON.stringify({ answer: 'Opened headphones can usually be returned within 30 days.', results: [] }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/return-policy-verify?question=${encodeURIComponent('Can I return opened headphones within 30 days?')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(sent, /return-policy question/);
  assert.equal(body.confidence, 0.55);
});

test('return-policy-verify: confidence rises when independent voters agree', async (t) => {
  withKey(t);
  process.env.GROQ_API_KEY = 'g';
  process.env.GEMINI_API_KEY = 'm';
  t.after(() => { delete process.env.GROQ_API_KEY; delete process.env.GEMINI_API_KEY; });
  const reply = JSON.stringify({ short: '90 days', full: 'Target allows returns within 90 days.' });
  stubFetch(t, (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({ answer: 'Target allows returns within 90 days.', results: [{ title: 'Target', url: 'https://example.com/t', content: 'x', score: 0.9 }] }), { status: 200 });
    }
    if (url.includes('groq.com')) return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
    if (url.includes('googleapis.com')) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] } }] }), { status: 200 });
    return undefined;
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/return-policy-verify?retailer=Target`)).json();
  assert.equal(body.confidence, 0.85);
});
