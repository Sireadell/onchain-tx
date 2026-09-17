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

const PPLX = 'https://api.perplexity.ai';

function stubPerplexity(t, content) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(PPLX)) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('text-classify: missing text answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/text-classify`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('text-classify: an unconfigured deployment says so instead of failing silently', async (t) => {
  withKey(t, null);
  const base = startServer(t);
  const res = await fetch(`${base}/text-classify?text=hello`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /PERPLEXITY_API_KEY/);
});

test('text-classify: returns the category and it is the graded answer', async (t) => {
  withKey(t);
  stubPerplexity(t, 'This is spam, because it promotes an unsolicited offer.');
  const base = startServer(t);
  const res = await fetch(`${base}/text-classify?text=${encodeURIComponent('WIN A FREE PRIZE NOW')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.summary, 'This is spam, because it promotes an unsolicited offer.');
  assert.equal(body.answer, body.summary);
});

test('text-classify: labels are passed through to the model and echoed back', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'positive');
  const base = startServer(t);
  await fetch(`${base}/text-classify?text=great+product&labels=positive,negative,neutral`);
  assert.match(calls[0].body.messages[0].content, /positive, negative, neutral/);
});

test('text-classify: the label leads the answer and a "Category:" prefix is dropped', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Category: Billing. The customer was charged twice.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/text-classify?text=charged+twice`)).json();
  assert.equal(body.summary, 'Billing. The customer was charged twice.');
  assert.equal(body.classification, 'Billing');
  assert.equal(body.confidence, 0.9);
  assert.equal(calls[0].body.disable_search, true);
  assert.equal(calls[0].body.messages[1].content, '<<<TEXT>>>\ncharged twice\n<<<END>>>');
});

test('text-classify: competitor param names are accepted', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Spam. Unsolicited offer.');
  const base = startServer(t);
  for (const qs of ['content=buy+now', 'input=buy+now', 'q=buy+now', 'message=buy+now', 'text=buy+now&categories=spam,ham']) {
    const body = await (await fetch(`${base}/text-classify?${qs}`)).json();
    assert.equal(body.status, 'ok', qs);
  }
});

test('text-classify: a huge text is capped and the answer says so', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Noise. Repeated characters.');
  const base = startServer(t);
  const res = await fetch(`${base}/text-classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(20000) }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(calls[0].body.messages[1].content.length < 12100);
  assert.match(body.summary, /Only the first 12000 characters/);
});
