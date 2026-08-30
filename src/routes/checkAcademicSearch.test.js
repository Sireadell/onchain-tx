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

test('academic-search: missing topic answered with guidance', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/academic-search`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

// Guards the defect an adversarial review found on 2026-08-29: results were
// sorted by citation count across the whole match set, which surfaced
// enormously-cited papers that had nothing to do with the topic ("federated
// learning" returned a paper on intelligent tutoring systems with 79,071
// citations). Relevance, not citations, has to decide which papers these
// are, so the property worth asserting is that they are actually on topic.
test('academic-search: results are actually about the topic asked for', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/academic-search?topic=${encodeURIComponent('federated learning')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.ok(body.papers.length > 0);
  assert.ok(body.total_matches > 0);

  const onTopic = body.papers.filter((p) => /federated/i.test(`${p.title} ${p.abstract_snippet ?? ''}`));
  assert.ok(
    onTopic.length >= Math.ceil(body.papers.length / 2),
    `expected most results to be about federated learning, got: ${body.papers.map((p) => p.title).join(' | ')}`,
  );
});

test('academic-search: Crossref keeps the route working when OpenAlex throttles', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.openalex.org/')) {
      return new Response('{}', { status: 429 });
    }
    if (String(url).startsWith('https://api.crossref.org/')) {
      return new Response(JSON.stringify({
        message: {
          'total-results': 1,
          items: [{
            DOI: '10.1000/example',
            title: ['Federated learning for clinical research'],
            author: [{ given: 'Ada', family: 'Lovelace' }],
            'container-title': ['Journal of Example Research'],
            issued: { 'date-parts': [[2024]] },
            'is-referenced-by-count': 12,
            type: 'journal-article',
          }],
        },
      }), { status: 200 });
    }
    return originalFetch(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const base = startServer(t);
  const res = await fetch(`${base}/academic-search?topic=${encodeURIComponent('federated learning')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.papers[0].title, 'Federated learning for clinical research');
  assert.equal(body.papers[0].venue, 'Journal of Example Research');
});

test('academic-search: a date range in the question is honoured', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/academic-search?topic=${encodeURIComponent('papers on CRISPR since 2020')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.from_year, 2020);
  assert.ok(body.papers.every((p) => p.year >= 2020), 'every paper should be published in 2020 or later');
});

test('academic-search: nonsense topic answered with guidance, not a 500', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/academic-search?topic=${encodeURIComponent('zzqxnonexistentresearchtopic123')}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});
