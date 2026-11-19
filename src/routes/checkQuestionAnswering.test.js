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

// Exact-source lookups: Wikipedia revision metadata and DOI records.
function stubExactSources(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:')) return original(url, init);
    calls.push(u);
    if (u.includes('en.wikipedia.org/w/api.php') && u.includes('revids=')) {
      return new Response(JSON.stringify({ query: { pages: [{ title: 'Silicon', revisions: [{ revid: 1382843447, parentid: 1, user: 'Kapicapybara', timestamp: '2026-10-30T16:25:24Z', size: 88460, comment: '' }] }] } }), { status: 200 });
    }
    if (u.includes('opencitations.net')) {
      return new Response(JSON.stringify([{ id: 'doi:10.1385/abab:135:1:43 omid:br/0610262333', title: 'Mutagenesis And Analysis Of Mold Aspergillus Niger.', author: 'Singh, O. V. [omid:ra/0610725401]', pub_date: '2006', venue: 'Applied Biochemistry And Biotechnology [issn:0273-2289]', volume: '', issue: '', page: '43-58', type: 'journal article', publisher: 'Springer [crossref:297]' }]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('a Wikipedia revision question is answered from that exact revision', async (t) => {
  stubExactSources(t);
  const base = startServer(t);
  const j = await (await fetch(`${base}/question-answering?question=${encodeURIComponent('Silicon, revision 1382843447, field revision editing timestamp in UTC.')}`)).json();
  assert.match(j.summary, /^The revision editing timestamp of Silicon, revision 1382843447 \(English Wikipedia\), is 2026-10-30T16:25:24Z \(UTC\)\./);
});

test('an npm upgrade question is answered from the official release notes', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:')) return original(url, init);
    if (u.startsWith('https://registry.npmjs.org/vitest')) return new Response(JSON.stringify({ version: '2.0.0', repository: { url: 'git+https://github.com/vitest-dev/vitest.git' } }), { status: 200 });
    if (u.endsWith('/releases/tags/v2.0.0')) return new Response(JSON.stringify({ html_url: 'https://github.com/vitest-dev/vitest/releases/tag/v2.0.0', body: '### Breaking Changes\n- Remove watchExclude - by @b\n### Features\n- x' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const j = await (await fetch(`${base}/question-answering?question=${encodeURIComponent('We run unit tests with vitest 1.6.0. Which defaults and APIs changed incompatibly in vitest 2.0.0?')}`)).json();
  assert.match(j.summary, /^Upgrading vitest from 1\.6\.0 to 2\.0\.0 brings 1 breaking change listed in the official vitest 2\.0\.0 release notes: 1\) Remove watchExclude\./);
  assert.deepEqual(j.breaking_changes, ['Remove watchExclude']);
});

test('when independent sources split, the best-supported answer is given with a note instead of a refusal', async (t) => {
  const saved = { TAVILY_API_KEY: process.env.TAVILY_API_KEY, GROQ_API_KEY: process.env.GROQ_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
  process.env.TAVILY_API_KEY = 'tvly-test';
  process.env.GROQ_API_KEY = 'gsk-test';
  delete process.env.GEMINI_API_KEY;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:')) return original(url, init);
    if (u.includes('api.tavily.com')) return new Response(JSON.stringify({ answer: 'Purple zebras migrate across Antarctica every winter.', results: [{ title: 'Zebra page', url: 'https://example.com/zebra', content: 'zebras' }] }), { status: 200 });
    if (u.includes('api.groq.com')) return new Response(JSON.stringify({ choices: [{ message: { content: '{"short":"Glaciers calve icebergs near Greenland.","full":"Glaciers calve icebergs near Greenland in spring, according to survey data."}' } }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const base = startServer(t);
  const j = await (await fetch(`${base}/question-answering?question=${encodeURIComponent('Which split-test fact qwerty applies here?')}`)).json();
  assert.equal(j.status, 'ok');
  assert.doesNotMatch(j.summary, /do not agree|not stating/);
  assert.match(j.summary, /Glaciers calve icebergs near Greenland in spring/);
  assert.match(j.summary, /Sources differ on some details/);
});
