import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import researchQueryRouter from './checkResearchQuery.js';

// Not yet wired into src/app.js (this batch is not integrated by the
// building agent; the coordinator wires it in by hand), so each test file
// in this batch mounts its own router on a minimal app rather than using
// buildApp().
function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/research-query', researchQueryRouter);
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

function withoutAnyKey(t) {
  const prevT = process.env.TAVILY_API_KEY;
  const prevP = process.env.PERPLEXITY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (prevT !== undefined) process.env.TAVILY_API_KEY = prevT;
    if (prevP !== undefined) process.env.PERPLEXITY_API_KEY = prevP;
  });
}

function stubTavily(t, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.tavily.com')) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function stubTavilyError(t, status) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.tavily.com')) return original(url, init);
    return new Response(JSON.stringify({ error: 'boom' }), { status });
  };
  t.after(() => { globalThis.fetch = original; });
}

test('research-query: missing question answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/research-query`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('research-query: happy path returns a single-paragraph answer with sources', async (t) => {
  withKey(t);
  stubTavily(t, {
    query: 'x',
    answer: 'The Great Barrier Reef is the largest coral reef system in the world, located off the coast of Queensland, Australia.',
    results: [{ title: 'Great Barrier Reef - Wikipedia', url: 'https://example.com/gbr', content: 'x', score: 0.9 }],
    response_time: 1.0,
  });
  const base = startServer(t);
  const res = await fetch(`${base}/research-query?query=${encodeURIComponent('what is the largest coral reef system')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /Great Barrier Reef/);
  assert.match(body.source_note, /Great Barrier Reef - Wikipedia/);
  assert.equal(body.canonical.startsWith('research-query:'), true);
});

test('research-query: alias params q/question/topic accepted', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: 'A well-sourced answer.', results: [], response_time: 1.0 });
  const base = startServer(t);
  for (const key of ['q', 'question', 'topic']) {
    const res = await fetch(`${base}/research-query?${key}=${encodeURIComponent('why is the sky blue')}`);
    assert.equal((await res.json()).status, 'ok', key);
  }
});

test('research-query: nonsense input with no letters is refused', async (t) => {
  withKey(t);
  const calls = stubTavily(t, { query: 'x', answer: 'x', results: [], response_time: 1.0 });
  const base = startServer(t);
  const res = await fetch(`${base}/research-query?query=${encodeURIComponent('????')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
  assert.equal(calls.length, 0);
});

test('research-query: an oversized question is capped before it reaches the provider', async (t) => {
  withKey(t);
  const calls = stubTavily(t, { query: 'x', answer: 'An answer.', results: [], response_time: 1.0 });
  const base = startServer(t);
  const res = await fetch(`${base}/research-query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `why is ${'the sky '.repeat(5000)}blue` }),
  });
  assert.equal(res.status, 200);
  assert.ok(calls[0].body.query.length < 4500, String(calls[0].body.query.length));
});

test('research-query: 12000+ character input does not crash the route', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: 'An answer.', results: [], response_time: 1.0 });
  const base = startServer(t);
  const res = await fetch(`${base}/research-query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'a'.repeat(12500) }),
  });
  assert.equal(res.status, 200);
});

test('research-query: provider failure answers 502, not a crash', async (t) => {
  withKey(t);
  stubTavilyError(t, 429);
  const base = startServer(t);
  const res = await fetch(`${base}/research-query?query=${encodeURIComponent('what year did WWII end')}`);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.status, 'error');
});

test('research-query: no provider configured answers 503', async (t) => {
  withoutAnyKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/research-query?query=${encodeURIComponent('what year did WWII end')}`);
  assert.equal(res.status, 503);
});

test('research-query: no sources found is an honest refusal, not a failure', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: '', results: [], response_time: 0.4 });
  const base = startServer(t);
  const res = await fetch(`${base}/research-query?query=${encodeURIComponent('asdkjhasdkjhasd nonsense query')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});
