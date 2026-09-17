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

test('text-generate: missing prompt answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/text-generate`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('text-generate: an unconfigured deployment says so instead of failing silently', async (t) => {
  withKey(t, null);
  const base = startServer(t);
  const res = await fetch(`${base}/text-generate?prompt=write+a+haiku`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /PERPLEXITY_API_KEY/);
});

test('text-generate: returns the generated text as the graded answer', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Leaves fall gently down / autumn whispers through the trees / winter waits ahead');
  const base = startServer(t);
  const res = await fetch(`${base}/text-generate?prompt=${encodeURIComponent('write a haiku about autumn')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.summary, 'Leaves fall gently down / autumn whispers through the trees / winter waits ahead');
  assert.equal(body.answer, body.summary);
});

test('text-generate: sends the prompt to the model verbatim', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'ok');
  const base = startServer(t);
  await fetch(`${base}/text-generate?prompt=${encodeURIComponent('write a short bio')}`);
  assert.equal(calls[0].body.messages[1].content, 'write a short bio');
});

test('text-generate: writes from the caller notes with the search off', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'A briefing.');
  const base = startServer(t);
  await fetch(`${base}/text-generate?prompt=${encodeURIComponent('Summarise these notes')}`);
  assert.equal(calls[0].body.disable_search, true);
});

test('text-generate: competitor param names are accepted', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Hello.');
  const base = startServer(t);
  for (const qs of ['text=say+hello', 'query=say+hello', 'q=say+hello', 'instruction=say+hello', 'message=say+hello']) {
    const body = await (await fetch(`${base}/text-generate?${qs}`)).json();
    assert.equal(body.status, 'ok', qs);
  }
});

test('text-generate: a real 3k-char notes prompt goes through whole, a 20k one is capped', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'A briefing.');
  const base = startServer(t);
  const notes = `Summarise these notes in about 150 words.\n\nNotes:\n${'- NASA did a thing (NASA, 2026-09-10)\n'.repeat(80)}`;
  await fetch(`${base}/text-generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: notes }) });
  assert.equal(calls[0].body.messages[1].content, notes);

  const res = await fetch(`${base}/text-generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'z'.repeat(20000) }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(calls[1].body.messages[1].content.length, 12000);
  assert.match(body.summary, /only the first part was used/);
});

test('text-generate: a provider failure is a real 502', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    return new Response('{}', { status: 401 });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const res = await fetch(`${base}/text-generate?prompt=hello`);
  assert.equal(res.status, 502);
});
