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

test('language-generate: missing text answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/language-generate`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('language-generate: an unconfigured deployment says so instead of failing silently', async (t) => {
  withKey(t, null);
  const base = startServer(t);
  const res = await fetch(`${base}/language-generate?text=hello`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /PERPLEXITY_API_KEY/);
});

test('language-generate: returns the transformed text and echoes the target', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Bonjour le monde');
  const base = startServer(t);
  const res = await fetch(`${base}/language-generate?text=${encodeURIComponent('hello world')}&target=French`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.summary, 'Bonjour le monde');
  assert.equal(body.target, 'French');
});

test('language-generate: the target is included in the model instruction', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'ok');
  const base = startServer(t);
  await fetch(`${base}/language-generate?text=hello&target=formal`);
  assert.match(calls[0].body.messages[0].content, /formal/);
});

test('language-generate: competitor param names are accepted and the search is off', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Hello, how are you?');
  const base = startServer(t);
  for (const qs of ['input=rewrite+formally:+hey', 'prompt=rewrite+formally:+hey', 'q=rewrite+formally:+hey', 'text=hey&tone=formal', 'text=hey&to=French']) {
    const body = await (await fetch(`${base}/language-generate?${qs}`)).json();
    assert.equal(body.status, 'ok', qs);
  }
  assert.equal(calls[0].body.disable_search, true);
});


test('language-generate: a huge text is capped and the answer says so', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Short.');
  const base = startServer(t);
  const res = await fetch(`${base}/language-generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'z'.repeat(20000), target: 'French' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls[0].body.messages[1].content.length, 12000);
  assert.match(body.summary, /only the first part was transformed/);
});
