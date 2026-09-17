import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function withKey(t, value = 'pplx-test-key') {
  const previous = process.env.PERPLEXITY_API_KEY;
  if (value) process.env.PERPLEXITY_API_KEY = value;
  else delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previous;
  });
}

function stubPerplexity(t, content, { status = 200, cost = 0.002 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { cost: { total_cost: cost } },
    }), { status, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('chat-complete: missing message answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/chat-complete`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('chat-complete: an unconfigured deployment says so instead of failing silently', async (t) => {
  withKey(t, null);
  const base = startServer(t);
  const res = await fetch(`${base}/chat-complete?message=hello`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /PERPLEXITY_API_KEY/);
});

test('chat-complete: replies directly to a message', async (t) => {
  withKey(t);
  stubPerplexity(t, 'The capital of France is Paris.');
  const base = startServer(t);
  const res = await fetch(`${base}/chat-complete?message=${encodeURIComponent('what is the capital of France')}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.summary, 'The capital of France is Paris.');
  assert.equal(body.answer, body.summary);
  assert.equal(body.cost_usd, 0.002);
});

test('chat-complete: a provider failure is a real 502, not a fake answer', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    return new Response('{}', { status: 500 });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const res = await fetch(`${base}/chat-complete?message=hello`);
  assert.equal(res.status, 502);
});

test('chat-complete: accepts the OpenAI-style messages array the router sends', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Hi!');
  const base = startServer(t);
  const messages = JSON.stringify([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
  const res = await fetch(`${base}/chat-complete?messages=${encodeURIComponent(messages)}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.message, 'hi');
  assert.equal(calls[0].body.messages[1].content, 'hi');
});

test('chat-complete: a prediction question is asked for a verdict and the verdict is echoed', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Unlikely — no Phase 3 trial has been registered for it.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/chat-complete?message=${encodeURIComponent('Will XYZ-123 complete Phase 3?')}`)).json();
  assert.equal(body.verdict, 'Unlikely');
  assert.equal(body.summary, 'Unlikely, no Phase 3 trial has been registered for it.');
  assert.match(calls[0].body.messages[0].content, /Likely, Unlikely, or Uncertain/);
});

test('chat-complete: an ordinary question is not asked for a verdict', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'There are 7 days in a week.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/chat-complete?message=${encodeURIComponent('How many days in a week?')}`)).json();
  assert.equal(body.verdict, null);
  assert.doesNotMatch(calls[0].body.messages[0].content, /Likely, Unlikely, or Uncertain/);
});

test('chat-complete: with the provider down, a prediction question still gets an honest 200', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    return new Response('{}', { status: 402 });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const res = await fetch(`${base}/chat-complete?message=${encodeURIComponent('Will Infacort receive FDA approval?')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /^Uncertain\./);
  assert.equal(body.confidence, 0.3);
  assert.match(body.degraded, /no credit/);
});

test('chat-complete: a rate limit is retried once before giving up', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const body = await (await fetch(`${base}/chat-complete?message=hello`)).json();
  assert.equal(calls, 2);
  assert.equal(body.summary, 'Hello.');
});

test('chat-complete: a huge message is capped before it reaches the provider', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'ok');
  const base = startServer(t);
  const res = await fetch(`${base}/chat-complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'y'.repeat(30000) }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls[0].body.messages[1].content.length, 12000);
  assert.match(body.summary, /only the first part was answered/);
});

test('chat-complete: leading preamble and markdown are stripped from the reply', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Sure! Here is your briefing:\n\n**NASA** did a thing[1][2].\n- item one\n- item two');
  const base = startServer(t);
  const body = await (await fetch(`${base}/chat-complete?message=brief+me`)).json();
  assert.equal(body.summary, 'NASA did a thing. item one item two');
});
