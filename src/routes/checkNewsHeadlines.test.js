import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { extractTopic } from './checkNewsHeadlines.js';

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

const EMPTY_RSS = '<rss><channel></channel></rss>';

function stubTavily(t, body, rss = EMPTY_RSS) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (/^https:\/\/(?:news\.google\.com|www\.bing\.com)/.test(String(url))) return new Response(rss, { status: 200 });
    if (!String(url).startsWith('https://api.tavily.com')) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

// Dates relative to now, so the stories stay inside the 3-day window.
const dayLabel = (back) => new Date(Date.now() - back * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const D1 = dayLabel(0);
const D2 = dayLabel(1);

// The shape the model is asked for: a one-line list of "Headline" (Source,
// date) entries. The result list carries the URLs the entries are matched to.
const TAVILY_LIST = {
  query: 'headlines about the election',
  answer: `"Election update: results expected tonight" (Example News, ${D1}); "Candidates make final push" (Example Wire, ${D2})`,
  results: [
    { title: 'Election update: results expected tonight | Example News', url: 'https://example.com/a', content: 'x', score: 0.9 },
    { title: 'Candidates make final push', url: 'https://example.com/b', content: 'y', score: 0.8 },
    { title: 'Election - Example News', url: 'https://example.com/section', content: 'z', score: 0.7 },
  ],
  response_time: 1.1,
};

// Free prose instead of the list, which is what Tavily's own answer looks
// like when Perplexity is down.
const TAVILY_PROSE = {
  query: 'headlines about the election',
  answer: 'Coverage of the election continues nationwide.',
  results: [
    { title: 'Election update: results expected tonight', url: 'https://example.com/a', content: 'x', score: 0.9 },
    { title: 'Candidates make final push', url: 'https://example.com/b', content: 'y', score: 0.8 },
  ],
  response_time: 1.1,
};

test('news-headlines: missing topic answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/news-headlines`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('news-headlines: parses the headline list, matches URLs, and leads the graded field with the stories', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_LIST);
  const base = startServer(t);
  const res = await fetch(`${base}/news-headlines?topic=election`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.headlines.length, 2);
  assert.deepEqual(body.headlines[0], {
    title: 'Election update: results expected tonight',
    source: 'Example News',
    published: D1,
    url: 'https://example.com/a',
  });
  assert.equal(body.headlines[1].url, 'https://example.com/b');
  assert.ok(body.summary.startsWith(`Recent coverage of election includes: "Election update: results expected tonight" (Example News, ${D1}); "Candidates make final push"`));
  assert.equal(calls[0].body.topic, 'news');
  assert.match(calls[0].body.query, /List the 6 most recent news headlines about election/);
});

test('news-headlines: falls back to the result titles when the answer is prose', async (t) => {
  withKey(t);
  stubTavily(t, TAVILY_PROSE);
  const base = startServer(t);
  const res = await fetch(`${base}/news-headlines?topic=election`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.headlines.length, 2);
  assert.equal(body.headlines[0].url, 'https://example.com/a');
  assert.match(body.summary, /Election update/);
  assert.equal(body.confidence, 0.7);
});

test('news-headlines: the whole question is reduced to its topic', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_LIST);
  const base = startServer(t);
  const res = await fetch(`${base}/news-headlines?topic=${encodeURIComponent('What are the top news headlines about technology in Middle East today?')}`);
  const body = await res.json();
  assert.equal(body.topic, 'technology in Middle East');
  assert.match(body.summary, /^Recent coverage of technology in Middle East includes/);
  assert.match(calls[0].body.query, /headlines about technology in Middle East, published within the last 3 days/);
});

test('news-headlines: topic extraction covers the real phrasings on the feed', () => {
  const cases = [
    ['Top technology headlines right now, as a list.', 'technology'],
    ["Give me today's top headlines on OPUS 5.1, as a headline list.", 'OPUS 5.1'],
    ['News headlines {Turkey}', 'Turkey'],
    ['Korean Headlines', 'Korean news'],
    ['What are the top news headlines about Headlines "USA" today?', 'USA'],
    ['Headlines', 'world news'],
    ['News headlines', 'world news'],
    ['Latest News Headlines worldwide', 'world news'],
    ['science', 'science'],
  ];
  for (const [input, want] of cases) assert.equal(extractTopic(input).topic, want, input);
  assert.equal(extractTopic('Russian News Headlines in last 48 hours').window, 'the last 48 hours');
  assert.equal(extractTopic('African News Headlines in last 72').window, 'the last 72 hours');
});

test('news-headlines: query/q/category/subject aliases are accepted', async (t) => {
  withKey(t);
  stubTavily(t, TAVILY_LIST);
  const base = startServer(t);
  for (const key of ['query', 'q', 'category', 'subject', 'keywords']) {
    const res = await fetch(`${base}/news-headlines?${key}=election`);
    assert.equal((await res.json()).status, 'ok', key);
  }
});

test('news-headlines: junk max_results falls back to the default and large values are capped', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_LIST);
  const base = startServer(t);
  for (const bad of ['abc', '0', '-1']) {
    const res = await fetch(`${base}/news-headlines?topic=election&max_results=${bad}`);
    assert.equal(res.status, 200);
    assert.match(calls.at(-1).body.query, /List the 6 most recent/);
  }
  await fetch(`${base}/news-headlines?topic=election&max_results=50`);
  assert.match(calls.at(-1).body.query, /List the 10 most recent/);
});

test('news-headlines: no headlines found is an answer, not a failure', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: '', results: [], response_time: 0.4 });
  const base = startServer(t);
  const res = await fetch(`${base}/news-headlines?topic=asdkjhasdkjh`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('news-headlines: reads the subject of a "what are today\'s top X headlines" question', async () => {
  const { extractTopic } = await import('./checkNewsHeadlines.js');
  assert.equal(extractTopic("What are today's top technology headlines?").topic, 'technology');
});

test('news-headlines: a headline dated well before the window is dropped', async () => {
  const { isWithinWindow } = await import('./checkNewsHeadlines.js');
  const now = Date.parse('2026-11-18T20:00:00Z');
  assert.equal(isWithinWindow('Dec. 25, 2025', 'the last 3 days', now), false);
  assert.equal(isWithinWindow('17 November 2026', 'the last 3 days', now), true);
  assert.equal(isWithinWindow(null, 'the last 3 days', now), true);
});

test('news-headlines: when every listed story is old, the dated news feeds answer instead of video clips', async (t) => {
  withKey(t);
  const now = new Date();
  const rss = `<rss><channel><item><title>Chipmaker unveils new AI processor - Reuters</title><link>https://news.google.com/t1</link><pubDate>${now.toUTCString()}</pubDate><source url="https://reuters.com">Reuters</source></item></channel></rss>`;
  stubTavily(t, {
    answer: '"Big Tech Stocks Today" (ts2.tech, 20 December 2025)',
    results: [
      { title: 'TECH NEWS - THE LAST 12 HOURS #Shorts', url: 'https://www.youtube.com/watch?v=x', content: 'x', score: 0.9 },
    ],
  }, rss);
  const base = startServer(t);
  const body = await (await fetch(`${base}/news-headlines?question=${encodeURIComponent("What are today's top technology headlines?")}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.headlines[0].title, 'Chipmaker unveils new AI processor');
  assert.equal(body.headlines[0].source, 'Reuters');
  assert.ok(!/Shorts|2025/.test(body.summary));
});
