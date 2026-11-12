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
    if (String(url).startsWith('https://news.google.com') || String(url).startsWith('https://www.bing.com')) return new Response('<rss><channel></channel></rss>', { status: 200 });
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
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.result_count, 0);
  assert.deepEqual(body.sources, []);
  assert.equal(body.confidence, 0.6);
  assert.match(body.summary, /No article about asdkjhasdkjh was published in the last 7 days/);
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

const RSS = `<rss><channel>
<item><title>Starship completes seventh test flight - Reuters</title><link>https://news.google.com/a1</link><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title>SpaceX eyes next launch window - Space.com</title><link>https://news.google.com/a2</link><pubDate>Sun, 08 Nov 2026 08:00:00 GMT</pubDate><source url="https://space.com">Space.com</source></item>
</channel></rss>`;

test('news-search: a short topic is answered from real articles with publisher and date, no paid search', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://www.bing.com')) return new Response('<rss><channel></channel></rss>', { status: 200 });
    if (String(url).startsWith('https://news.google.com')) { urls.push(String(url)); return new Response(RSS, { status: 200 }); }
    if (String(url).startsWith('https://api.tavily.com')) throw new Error('paid search must not run for a short topic');
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const body = await (await fetch(`${base}/news-search?query=latest+news+on+SpaceX+Starship`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /Starship completes seventh test flight/);
  assert.match(body.summary, /Reuters, 9 November 2026/);
  assert.equal(body.headline, 'Starship completes seventh test flight');
  assert.equal(body.source, 'Reuters');
  assert.equal(body.articles.length, 2);
  assert.ok(decodeURIComponent(urls[0]).includes('SpaceX Starship when:7d'));
});

test('news-search: when the news feed is down the AI search still answers', async (t) => {
  withKey(t);
  stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  const body = await (await fetch(`${base}/news-search?query=${encodeURIComponent('has the merger been approved by the regulators yet?')}`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /approved by regulators/);
});

const RSS3 = `<rss><channel>
<item><title>OpenAI ships a model - Reuters</title><link>https://news.google.com/b1</link><pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title>OpenAI raises funds - Bloomberg</title><link>https://news.google.com/b2</link><pubDate>Mon, 09 Nov 2026 09:00:00 GMT</pubDate><source url="https://bloomberg.com">Bloomberg</source></item>
<item><title>OpenAI hires a chief - FT</title><link>https://news.google.com/b3</link><pubDate>Sun, 08 Nov 2026 09:00:00 GMT</pubDate><source url="https://ft.com">FT</source></item>
</channel></rss>`;

test('news-search: an empty feed is retried with a simplified query, and an AI answer with no sources is not what gets published', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  const googleUrls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://www.bing.com')) return new Response('<rss><channel></channel></rss>', { status: 200 });
    if (u.startsWith('https://news.google.com')) {
      googleUrls.push(u);
      return new Response(googleUrls.length === 1 ? '<rss><channel></channel></rss>' : RSS3, { status: 200 });
    }
    if (u.startsWith('https://api.tavily.com')) return new Response(JSON.stringify({ answer: 'x', results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const body = await (await fetch(`${base}/news-search?query=${encodeURIComponent('recent advancements in quantum computing research by IBM')}&recent_days=7`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.result_count, 3);
  assert.notEqual(body.status, 'invalid_input');
  assert.equal(googleUrls.length, 2);
  assert.ok(decodeURIComponent(googleUrls[1]).includes('when:30d'));
  assert.ok(['answer', 'summary'].includes(Object.keys(body)[0]));
  assert.match(body.summary, /OpenAI ships a model \(Reuters, 2026-11-09\)/);
  assert.ok(!body.summary.includes('news.google.com'));
  assert.ok(body.brief.length <= 80);
  assert.equal(body.sources.length, 3);
});

test('news-search: Bing results are merged with Google and duplicates dropped', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  const BING = `<rss><channel>
<item><title>Starship completes seventh test flight</title><link>http://www.bing.com/news/apiclick.aspx?ref=x&amp;url=https%3a%2f%2fexample.com%2fdup&amp;c=1</link><pubDate>${new Date().toUTCString()}</pubDate><News:Source>Reuters</News:Source></item>
<item><title>Starship fuel test passes</title><link>http://www.bing.com/news/apiclick.aspx?ref=x&amp;url=https%3a%2f%2fexample.com%2fnew&amp;c=1</link><pubDate>${new Date().toUTCString()}</pubDate><News:Source>Wired</News:Source></item>
</channel></rss>`;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://www.bing.com')) return new Response(BING, { status: 200 });
    if (u.startsWith('https://news.google.com')) return new Response(RSS, { status: 200 });
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const body = await (await fetch(`${base}/news-search?query=SpaceX+Starship&recent_days=30`)).json();
  assert.equal(body.result_count, 3);
  assert.ok(body.sources.some((s) => s.url === 'https://example.com/new'));
});
