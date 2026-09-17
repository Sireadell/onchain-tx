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

function withKeys(t, { perplexity = null, tavily = null } = {}) {
  const previous = {
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  };
  const applied = { PERPLEXITY_API_KEY: perplexity, TAVILY_API_KEY: tavily };
  for (const [name, value] of Object.entries(applied)) {
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const TVLY = 'https://api.tavily.com';

function stubTavily(t, body) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith(TVLY)) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const TAVILY_OK = {
  query: 'carbon capture approaches',
  answer: 'Direct air capture and enhanced weathering are the two leading approaches.',
  results: [
    { title: 'DAC overview', url: 'https://example.com/dac', content: 'Direct air capture pulls CO2 from ambient air.', score: 0.9 },
    { title: 'Weathering study', url: 'https://example.org/weathering', content: 'Enhanced weathering accelerates mineral CO2 uptake.', score: 0.85 },
  ],
  response_time: 1.1,
};

test('research-synthesis: missing query answered with guidance, not a 400', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  const base = startServer(t);
  const res = await fetch(`${base}/research-synthesis`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('research-synthesis: an unconfigured deployment says so instead of failing silently', async (t) => {
  withKeys(t, {});
  const base = startServer(t);
  const res = await fetch(`${base}/research-synthesis?query=anything`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /PERPLEXITY_API_KEY/);
});

test('research-synthesis: the graded field is the synthesis alone, sources are named beside it', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  const res = await fetch(`${base}/research-synthesis?query=${encodeURIComponent('carbon capture approaches')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.source_count, 2);
  assert.equal(body.summary, 'Direct air capture and enhanced weathering are the two leading approaches.');
  assert.match(body.source_note, /DAC overview/);
  assert.match(body.source_note, /Weathering study/);
  assert.doesNotMatch(body.summary, /https?:/);
});

test('research-synthesis: the question is wrapped as data after the instruction', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/research-synthesis?query=${encodeURIComponent('carbon capture approaches')}`);
  assert.match(calls[0].body.query, /Research question: carbon capture approaches/);
  assert.match(calls[0].body.query, /main conclusion first/);
});

test('research-synthesis: junk max_sources falls back to the default, large values are capped', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  for (const bad of ['abc', '0', '-5']) {
    const res = await fetch(`${base}/research-synthesis?query=test&max_sources=${bad}`);
    assert.equal(res.status, 200);
    assert.equal(calls.at(-1).body.max_results, 10, bad);
  }
  await fetch(`${base}/research-synthesis?query=test&max_sources=999`);
  assert.equal(calls.at(-1).body.max_results, 20);
});

test('research-synthesis: a query with no words is refused, not searched', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  const res = await fetch(`${base}/research-synthesis?query=%3F`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(calls.length, 0);
});

test('research-synthesis: defaults to a wider source count than web-search', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/research-synthesis?query=test`);
  assert.equal(calls[0].body.max_results, 10);
});
