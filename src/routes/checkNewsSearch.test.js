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

function withKey(t, value = 'tvly-test-key') {
  const previous = process.env.TAVILY_API_KEY;
  if (value) process.env.TAVILY_API_KEY = value;
  else delete process.env.TAVILY_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  });
}

function stubTavily(t, body, { status = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.tavily.com')) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const TAVILY_OK = {
  query: 'latest on the merger',
  answer: 'The merger was approved by regulators on Tuesday.',
  results: [
    { title: 'Merger approved', url: 'https://example.com/merger', content: 'Regulators approved the deal.', score: 0.9 },
  ],
  response_time: 1.1,
};

test('news-search: missing query answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/news-search`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('news-search: an unconfigured deployment says so instead of failing silently', async (t) => {
  withKey(t, null);
  const base = startServer(t);
  const res = await fetch(`${base}/news-search?query=anything`);
  assert.equal(res.status, 503);
});

test('news-search: answers from a news search and names sources', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  const res = await fetch(`${base}/news-search?query=latest+on+the+merger`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.summary, 'The merger was approved by regulators on Tuesday.');
  assert.match(body.source_note, /Merger approved/);
  assert.equal(calls[0].body.topic, 'news');
});

test('news-search: nothing matched is an answer, not a failure', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: '', results: [], response_time: 0.4 });
  const base = startServer(t);
  const res = await fetch(`${base}/news-search?query=asdkjhasdkjh`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('news-search: a bare topic is framed as a news search before it reaches the provider', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/news-search?query=bitcoin`);
  assert.match(calls[0].body.query, /News search: Latest news about bitcoin/);
  assert.match(calls[0].body.query, /the last 7 days/);
});

test('news-search: a whole question is passed as asked, with the caller\'s window applied', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/news-search?q=${encodeURIComponent('what is the latest on the merger?')}&recent_days=30`);
  assert.match(calls[0].body.query, /News search: what is the latest on the merger\?/);
  assert.match(calls[0].body.query, /the last 30 days/);
});

test('news-search: keywords/search/subject/text aliases are accepted', async (t) => {
  withKey(t);
  stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  for (const key of ['keywords', 'search', 'subject', 'text', 'category']) {
    const res = await fetch(`${base}/news-search?${key}=merger`);
    assert.equal((await res.json()).status, 'ok', key);
  }
});

test('news-search: junk max_results falls back to the default and the graded field is the answer alone', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  for (const bad of ['abc', '0', '-4']) {
    const res = await fetch(`${base}/news-search?query=merger&max_results=${bad}`);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.summary, 'The merger was approved by regulators on Tuesday.');
  }
  assert.ok(calls.every((c) => c.body.max_results === 5));
  const res = await fetch(`${base}/news-search?query=merger&max=999`);
  assert.equal(res.status, 200);
  assert.equal(calls.at(-1).body.max_results, 20);
});

test('news-search: an oversized query is capped before it reaches the provider', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/news-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'merger '.repeat(3000) }),
  });
  assert.ok(calls[0].body.query.length < 4700);
});
