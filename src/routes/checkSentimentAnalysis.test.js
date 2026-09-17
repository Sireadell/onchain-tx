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

function stubPerplexity(t, content) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { cost: { total_cost: 0.001 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('sentiment-analyze: missing text answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/sentiment-analyze`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('sentiment-analyze: extracts the label from the model reply', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Positive. The message expresses clear enthusiasm.');
  const base = startServer(t);
  const res = await fetch(`${base}/sentiment-analyze?text=${encodeURIComponent('I love this!')}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.sentiment, 'Positive');
  assert.equal(body.confidence, 0.9);
});

test('sentiment-analyze: an unparsable reply still answers, at lower confidence', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Hard to say honestly.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/sentiment-analyze?text=hmm`)).json();

  assert.equal(body.status, 'ok');
  assert.equal(body.sentiment, null);
  assert.equal(body.confidence, 0.6);
});

test('sentiment-analyze: a label buried in the reply is pulled to the front', async (t) => {
  withKey(t);
  stubPerplexity(t, 'The general sentiment toward Log4Shell is negative because it is a critical flaw.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/sentiment-analyze?text=${encodeURIComponent('What is the general sentiment toward CVE-2021-44228?')}`)).json();
  assert.equal(body.sentiment, 'Negative');
  assert.match(body.summary, /^Negative\. The general sentiment/);
});

test('sentiment-analyze: a question about a subject keeps the search on, supplied text turns it off', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Negative. Bad.');
  const base = startServer(t);
  await fetch(`${base}/sentiment-analyze?text=${encodeURIComponent('What is the general sentiment toward token XYZ?')}`);
  await fetch(`${base}/sentiment-analyze?text=${encodeURIComponent('Analyze the sentiment of this review: "it broke on day two"')}`);
  assert.equal(calls[0].body.disable_search, undefined);
  assert.equal(calls[1].body.disable_search, true);
  assert.match(calls[1].body.messages[1].content, /^<<<TEXT>>>\n/);
});

test('sentiment-analyze: competitor param names are accepted', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Negative. Anger.');
  const base = startServer(t);
  for (const qs of ['content=I+hate+this', 'review=I+hate+this', 'message=I+hate+this', 'comment=I+hate+this', 'q=I+hate+this']) {
    const body = await (await fetch(`${base}/sentiment-analyze?${qs}`)).json();
    assert.equal(body.status, 'ok', qs);
    assert.equal(body.sentiment, 'Negative', qs);
  }
});

test('sentiment-analyze: a provider failure is a real 502', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    return new Response('{}', { status: 500 });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const res = await fetch(`${base}/sentiment-analyze?text=hello`);
  assert.equal(res.status, 502);
});
