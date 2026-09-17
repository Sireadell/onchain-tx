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
  query: 'did the merger close',
  answer: 'Yes, the merger closed on schedule after receiving regulatory approval.',
  results: [{ title: 'Merger completes', url: 'https://example.com/merger', content: 'The deal closed today.', score: 0.9 }],
  response_time: 1.0,
};

test('event-outcome: missing query answered with guidance, not a 400', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  const base = startServer(t);
  const res = await fetch(`${base}/event-outcome`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('event-outcome: an unconfigured deployment says so instead of failing silently', async (t) => {
  withKeys(t, {});
  const base = startServer(t);
  const res = await fetch(`${base}/event-outcome?query=anything`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /PERPLEXITY_API_KEY/);
});

test('event-outcome: resolves to the verdict, keeps the graded field to the outcome, names sources beside it', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  const res = await fetch(`${base}/event-outcome?query=${encodeURIComponent('did the merger close?')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.summary, 'Yes, the merger closed on schedule after receiving regulatory approval.');
  assert.equal(body.outcome, 'yes');
  assert.equal(body.confidence, 0.9);
  assert.match(body.source_note, /Merger completes/);
});

test('event-outcome: the resolution instruction wraps the question as data', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/event-outcome?query=${encodeURIComponent('did the merger close?')}`);
  assert.match(calls[0].body.query, /Begin your reply with "Yes," or "No,"/);
  assert.match(calls[0].body.query, /Not yet resolved/);
  assert.match(calls[0].body.query, /Question: did the merger close\?$/);
});

test('event-outcome: a pending event is reported as unresolved at lower confidence', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  stubTavily(t, { ...TAVILY_OK, answer: 'Not yet resolved, the trial is still recruiting as of September 2026.' });
  const base = startServer(t);
  const res = await fetch(`${base}/event-outcome?query=${encodeURIComponent('Will Acme complete its trial?')}`);
  const body = await res.json();
  assert.equal(body.outcome, 'unresolved');
  assert.equal(body.confidence, 0.7);
});

test('event-outcome: event/market/text aliases are accepted and a wordless query is refused', async (t) => {
  withKeys(t, { tavily: 'tvly-test-key' });
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  for (const key of ['event', 'market', 'text', 'q']) {
    const res = await fetch(`${base}/event-outcome?${key}=${encodeURIComponent('did the merger close?')}`);
    assert.equal((await res.json()).status, 'ok', key);
  }
  const before = calls.length;
  const res = await fetch(`${base}/event-outcome?query=%3F`);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(calls.length, before);
});
