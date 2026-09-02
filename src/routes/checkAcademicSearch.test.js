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

test('academic-search: unrelated free-text question is refused before any call', async (t) => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (String(url).startsWith('http://127.0.0.1:')) return original(url, ...rest);
    called = true;
    throw new Error('should not be called');
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);

  const res = await fetch(`${base}/academic-search?query=${encodeURIComponent('What is the Bitcoin price?')}`);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('academic-search: ordinary research wording is refused before any upstream call', async (t) => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (String(url).startsWith('http://127.0.0.1:')) return original(url, ...rest);
    called = true;
    throw new Error('should not be called');
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const res = await fetch(`${base}/academic-search?query=${encodeURIComponent('Research the cheapest flight to Miami')}`);
  assert.equal((await res.json()).status, 'invalid_input');
  assert.equal(called, false);
});

test('academic-search: weak scholarly-looking and terse q wording is refused', async (t) => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    if (String(url).startsWith('http://127.0.0.1:')) return original(url, ...rest);
    called = true;
    throw new Error('should not be called');
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  for (const q of ['news article', 'shopping articles', 'police findings', 'personal journal', 'published']) {
    const res = await fetch(`${base}/academic-search?q=${encodeURIComponent(q)}`);
    assert.equal((await res.json()).status, 'invalid_input', q);
  }
  assert.equal(called, false);
});

test('academic-search: literature, publication, article and imperative research framing is accepted', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.openalex.org/')) {
      calls += 1;
      return new Response(JSON.stringify({ meta: { count: 0 }, results: [] }), { status: 200 });
    }
    return originalFetch(url);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const base = startServer(t);
  for (const q of ['Find literature on federated learning', 'What does the literature say about mRNA vaccines?', 'Show me publications about CRISPR', 'Find scientific articles on CRISPR', 'Find articles on AI safety', 'Research federated learning', 'Find systematic reviews about long COVID', 'Find 10 studies on malaria vaccines since 2020', 'Recent studies on AI safety', 'Literature review on conflict resolution']) {
    const res = await fetch(`${base}/academic-search?q=${encodeURIComponent(q)}`);
    assert.notEqual((await res.json()).summary, 'This request does not appear to ask for academic research. Ask for papers, studies, articles, or research on a topic.', q);
  }
  assert.equal(calls, 10);
});

test('academic-search: a terse CRISPR topic is accepted', async (t) => {
  const originalFetch = globalThis.fetch;
  let requestedSearch = null;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.openalex.org/')) {
      requestedSearch = new URL(url).searchParams.get('search');
      return new Response(JSON.stringify({
        meta: { count: 1 },
        results: [{
          title: 'CRISPR gene editing in human cells',
          publication_year: 2025,
          cited_by_count: 12,
          authorships: [],
          primary_location: null,
          abstract_inverted_index: null,
        }],
      }), { status: 200 });
    }
    return originalFetch(url);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const base = startServer(t);

  const res = await fetch(`${base}/academic-search?query=${encodeURIComponent('CRISPR gene editing')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(requestedSearch, 'CRISPR gene editing');
  assert.equal(body.papers.length, 1);
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

test('academic-search: extracts result count and topic from a natural-language request', async (t) => {
  const originalFetch = globalThis.fetch;
  let requestedSearch;
  let requestedCount;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.openalex.org/')) {
      const parsed = new URL(url);
      requestedSearch = parsed.searchParams.get('search');
      requestedCount = parsed.searchParams.get('per_page');
      return new Response(JSON.stringify({
        meta: { count: 5 },
        results: Array.from({ length: 5 }, (_, index) => ({
          title: `Paper ${index + 1}`,
          publication_year: 2025,
          cited_by_count: index,
          authorships: [],
          primary_location: null,
          abstract_inverted_index: null,
        })),
      }), { status: 200 });
    }
    return originalFetch(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const base = startServer(t);

  const res = await fetch(`${base}/academic-search?query=${encodeURIComponent('Find 5 peer-reviewed papers on federated learning')}`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(requestedSearch, 'federated learning');
  assert.equal(requestedCount, '5');
  assert.equal(body.papers.length, 5);
  assert.match(body.summary, /5 peer-reviewed papers on federated learning/);
});

test('academic-search: upstream failures are errors with zero confidence', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://api.openalex.org/')) {
      return new Response('{}', { status: 429 });
    }
    if (String(url).startsWith('https://api.crossref.org/')) {
      return new Response('{}', { status: 503 });
    }
    return originalFetch(url);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const base = startServer(t);

  const res = await fetch(`${base}/academic-search?query=${encodeURIComponent('Find papers on federated learning')}`);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.status, 'error');
  assert.equal(body.confidence, 0);
  assert.notEqual(body.status, 'invalid_input');
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
