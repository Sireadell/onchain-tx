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
  assert.equal(body.count, 2);
  assert.ok(body.answer.startsWith(`Top 2 headlines on election, published ${D2} to ${D1}: 1. "Election update: results expected tonight" (Example News); 2. "Candidates make final push" (Example Wire)`));
  assert.equal(body.summary, '2 current headlines on election.');
  assert.equal(body.headlines, undefined, 'the list is carried once, as text');
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
  assert.equal(body.count, 2);
  assert.match(body.answer, /1\. "Election update: results expected tonight"/);
  assert.equal(body.confidence, 0.7);
});

test('news-headlines: the whole question is reduced to its topic', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_LIST);
  const base = startServer(t);
  const res = await fetch(`${base}/news-headlines?topic=${encodeURIComponent('What are the top news headlines about technology in Middle East today?')}`);
  const body = await res.json();
  assert.equal(body.topic, 'technology in Middle East');
  assert.match(body.answer, /^Top 2 headlines on technology in Middle East, published .+: 1\./);
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
  assert.match(body.answer, /^Top 1 headline on technology, published \d{1,2} \w+ \d{4}: 1\. "Chipmaker unveils new AI processor" \(Reuters\)/);
  assert.ok(!/Shorts|2025/.test(body.answer));
});

// Round 14 (2026-11-19): "top 5" was read as the topic "5" and the answer
// listed sports scores. The count sets how many, and the real subject (and a
// place named before it) is what gets searched.
test('news-headlines: "top 5" is a count, not the topic, and the place joins the subject', () => {
  const a = extractTopic('What are the top 5 news headlines regarding the ongoing semiconductor shortage in Asia today?');
  assert.equal(a.topic, 'semiconductor shortage in Asia');
  assert.equal(a.count, 5);
  const b = extractTopic('What are the top 5 news headlines in London today regarding the housing market?');
  assert.equal(b.topic, 'the housing market in London');
  assert.equal(b.count, 5);
  const c = extractTopic('What are the top 5 news headlines regarding the upcoming G7 summit in Italy?');
  assert.equal(c.topic, 'G7 summit in Italy');
  assert.equal(extractTopic('Top 3 tech headlines right now').count, 3);
  assert.equal(extractTopic('Give me the 10 latest headlines about Bitcoin').topic, 'Bitcoin');
  assert.equal(extractTopic('What are the latest headlines regarding the ongoing drought in California?').count, null);
});

test('news-headlines: a count in the question sets how many headlines are listed', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_LIST);
  const base = startServer(t);
  await fetch(`${base}/news-headlines?query=${encodeURIComponent('What are the top 5 news headlines regarding the ongoing semiconductor shortage in Asia today?')}`);
  assert.match(calls.at(-1).body.query, /List the 5 most recent news headlines about semiconductor shortage in Asia/);
  await fetch(`${base}/news-headlines?query=${encodeURIComponent('top 5 headlines on the election')}&max_results=3`);
  assert.match(calls.at(-1).body.query, /List the 3 most recent/, 'an explicit max_results still wins');
});

// Round 16 (2026-11-19): the search key ran out of credit and every question
// answered a 502. The free dated feeds answer instead.
test('news-headlines: a failed search provider falls back to the dated news feeds', async (t) => {
  withKey(t);
  const now = new Date();
  const rss = `<rss><channel><item><title>Reservoirs stay low as drought drags on - LA Times</title><link>https://news.google.com/t1</link><pubDate>${now.toUTCString()}</pubDate><source url="https://latimes.com">LA Times</source></item></channel></rss>`;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/^https:\/\/(?:news\.google\.com|www\.bing\.com)/.test(String(url))) return new Response(rss, { status: 200 });
    if (String(url).startsWith('https://api.tavily.com')) return new Response('{"detail":"no credit"}', { status: 432 });
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const res = await fetch(`${base}/news-headlines?query=${encodeURIComponent('What are the latest headlines regarding the ongoing drought in California?')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.answer, /Reservoirs stay low as drought drags on/);
  assert.equal(body.source, 'Google News and Bing News');
});

test('news-headlines: the publication dates are given once, as a span', async () => {
  const { publishedSpan } = await import('./checkNewsHeadlines.js');
  assert.equal(publishedSpan([{ published: '2026-11-18' }, { published: '16 November 2026' }, { published: null }]), 'published 16 November 2026 to 18 November 2026');
  assert.equal(publishedSpan([{ published: '2026-11-18' }]), 'published 18 November 2026');
  assert.equal(publishedSpan([{ published: null }]), '');
});
