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

test('fact-check: missing claim answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('fact-check: extracts a True/False verdict and names sources', async (t) => {
  withKey(t);
  stubTavily(t, {
    query: 'is the earth flat',
    answer: 'False. The Earth is an oblate spheroid, confirmed by centuries of scientific measurement.',
    results: [{ title: 'Earth shape - Wikipedia', url: 'https://example.com/earth', content: 'x', score: 0.9 }],
    response_time: 1.0,
  });
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check?claim=${encodeURIComponent('the earth is flat')}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'False');
  assert.match(body.source_note, /Earth shape/);
});

test('fact-check: no sources found is an answer, not a failure', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: '', results: [], response_time: 0.4 });
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check?claim=asdkjhasdkjh`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('fact-check: the verdict is read from the start, not the first verdict word in the prose', async (t) => {
  withKey(t);
  stubTavily(t, {
    query: 'x',
    answer: 'True. The claim that the Eiffel Tower is in Berlin is False, so the statement as written is correct.',
    results: [],
    response_time: 1.0,
  });
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check?claim=${encodeURIComponent('The claim that the Eiffel Tower is in Berlin is False')}`);
  const body = await res.json();
  assert.equal(body.verdict, 'True');
  assert.match(body.summary, /^True\./);
});

test('fact-check: "Mostly True" is not read as "True"', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: 'Mostly True. The network launched in 2009 but the whitepaper was 2008.', results: [], response_time: 1.0 });
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check?claim=${encodeURIComponent('bitcoin was created in 2009')}`);
  const body = await res.json();
  assert.equal(body.verdict, 'Mostly True');
  assert.equal(body.confidence, 0.75);
});

test('fact-check: a verdict buried mid-answer is hoisted to the front of the graded field', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: 'Sources agree this is False because the tower is in Paris.', results: [], response_time: 1.0 });
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check?claim=${encodeURIComponent('the Eiffel Tower is in Berlin')}`);
  const body = await res.json();
  assert.equal(body.verdict, 'False');
  assert.match(body.summary, /^False\. Sources agree/);
});

test('fact-check: router framing is peeled and the claim reaches the provider as data after the instruction', async (t) => {
  withKey(t);
  const calls = stubTavily(t, { query: 'x', answer: 'False. Paris.', results: [], response_time: 1.0 });
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check?query=${encodeURIComponent('Is it true that the Eiffel Tower is in Berlin?')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.claim, 'the Eiffel Tower is in Berlin');
  assert.match(calls[0].body.query, /Begin your reply with exactly one of these words/);
  assert.match(calls[0].body.query, /Claim: "the Eiffel Tower is in Berlin"$/);
});

test('fact-check: statement/text/q aliases are accepted', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: 'False. Not cheese.', results: [], response_time: 1.0 });
  const base = startServer(t);
  for (const key of ['statement', 'text', 'q']) {
    const res = await fetch(`${base}/fact-check?${key}=${encodeURIComponent('the moon is made of cheese')}`);
    assert.equal((await res.json()).status, 'ok', key);
  }
});

test('fact-check: a claim with no substance is refused with the value quoted, not sent upstream', async (t) => {
  withKey(t);
  const calls = stubTavily(t, { query: 'x', answer: 'x', results: [], response_time: 1.0 });
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check?claim=${encodeURIComponent('?')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /"\?"/);
  assert.equal(calls.length, 0);
});

test('fact-check: an oversized claim is capped before it reaches the provider', async (t) => {
  withKey(t);
  const calls = stubTavily(t, { query: 'x', answer: 'Unverified. Nothing.', results: [], response_time: 1.0 });
  const base = startServer(t);
  const res = await fetch(`${base}/fact-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim: `the moon is ${'very '.repeat(5000)}far` }),
  });
  assert.equal(res.status, 200);
  assert.ok(calls[0].body.query.length < 2700, String(calls[0].body.query.length));
});
