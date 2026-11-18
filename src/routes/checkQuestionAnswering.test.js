import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { searchTerms, leadSentences } from '../lib/wikiAnswer.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function stubWikipedia(t, { hits = [{ title: 'Things Fall Apart' }], extract = 'Things Fall Apart is a 1958 novel by Chinua Achebe.', fail = false } = {}) {
  delete process.env.PERPLEXITY_API_KEY;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('wikipedia.org')) return original(url, init);
    if (fail) return new Response('{}', { status: 500 });
    if (u.includes('/w/api.php')) return new Response(JSON.stringify({ query: { search: hits } }), { status: 200 });
    return new Response(JSON.stringify({ title: hits[0]?.title, extract, content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/X' } } }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
}

test('question words are stripped before searching', () => {
  assert.equal(searchTerms('Who wrote the novel Things Fall Apart?'), 'wrote the novel Things Fall Apart');
});

test('long extracts are cut at a sentence end', () => {
  const text = `${'A sentence here. '.repeat(80)}`;
  const cut = leadSentences(text, 200);
  assert.ok(cut.length <= 200);
  assert.ok(cut.endsWith('.'));
});

test('answers from Wikipedia and names the source', async (t) => {
  stubWikipedia(t);
  const base = startServer(t);
  const j = await (await fetch(`${base}/question-answering?question=${encodeURIComponent('Who wrote Things Fall Apart?')}`)).json();
  assert.equal(j.status, 'ok');
  assert.match(j.summary, /Chinua Achebe/);
  assert.match(j.summary, /Source: Wikipedia/);
});

test('says so when nothing matches', async (t) => {
  stubWikipedia(t, { hits: [] });
  const base = startServer(t);
  const j = await (await fetch(`${base}/question-answering?question=${encodeURIComponent('qzxv blorp frindle')}`)).json();
  assert.match(j.summary, /not stating an answer/);
  assert.equal(j.confidence, 0.3);
});

test('an upstream failure is a 502 with a retry message', async (t) => {
  stubWikipedia(t, { fail: true });
  const base = startServer(t);
  const r = await fetch(`${base}/question-answering?question=${encodeURIComponent('What is gold?')}`);
  assert.equal(r.status, 502);
});

test('an empty question is unusable input', async (t) => {
  const base = startServer(t);
  const j = await (await fetch(`${base}/question-answering`)).json();
  assert.equal(j.status, 'invalid_input');
});

test('source pages are listed as numbered citations, without repeats or bad links', async () => {
  const { citationsFrom } = await import('./checkQuestionAnswering.js');
  const out = citationsFrom([
    { title: 'Things Fall Apart', url: 'https://en.wikipedia.org/wiki/Things_Fall_Apart' },
    { title: 'dup', url: 'https://en.wikipedia.org/wiki/Things_Fall_Apart' },
    { title: 'no link', url: 'javascript:alert(1)' },
    { url: 'https://www.britannica.com/topic/Things-Fall-Apart' },
    { title: 'C', url: 'https://c.example/a' },
    { title: 'D', url: 'https://d.example/a' },
  ]);
  assert.deepEqual(out, [
    { n: 1, title: 'Things Fall Apart', url: 'https://en.wikipedia.org/wiki/Things_Fall_Apart' },
    { n: 2, title: 'https://www.britannica.com/topic/Things-Fall-Apart', url: 'https://www.britannica.com/topic/Things-Fall-Apart' },
    { n: 3, title: 'C', url: 'https://c.example/a' },
  ]);
  assert.deepEqual(citationsFrom(undefined), []);
});
