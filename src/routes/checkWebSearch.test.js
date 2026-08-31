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

// Every test that gets past the configuration check needs a key present, and
// none of them should leave one behind for the rest of the suite. Each test
// states exactly which providers are configured, because which one answers
// depends entirely on that.
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

const withKey = (t, value = 'tvly-test-key') => withKeys(t, { tavily: value });

// Captures what the route sent upstream so the request body can be asserted
// on, and replies with whatever Tavily body the test supplies.
function stubTavily(t, body, { status = 200 } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    // The tests drive the route over real HTTP, so their own requests to the
    // local server come through here too. Only the upstream call is faked.
    if (!String(url).startsWith('https://api.tavily.com')) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const TAVILY_OK = {
  query: 'who won the 2026 world cup',
  answer: 'Argentina won the 2026 FIFA World Cup, beating France in the final.',
  results: [
    { title: 'World Cup final report', url: 'https://example.com/final', content: 'Argentina lifted the trophy.', score: 0.94 },
    { title: 'Tournament summary', url: 'https://example.org/summary', content: 'A recap of the tournament.', score: 0.81 },
  ],
  response_time: 1.4,
};

test('web-search: missing query answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/web-search`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('web-search: an unconfigured deployment says so instead of failing silently', async (t) => {
  withKeys(t, {});
  const base = startServer(t);
  const res = await fetch(`${base}/web-search?query=anything`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /PERPLEXITY_API_KEY/);
});

test('web-search: answers a question and names its sources', async (t) => {
  withKey(t);
  stubTavily(t, TAVILY_OK);
  const base = startServer(t);

  const res = await fetch(`${base}/web-search?query=who+won+the+2026+world+cup`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.status, 'ok');
  assert.equal(body.result_count, 2);
  assert.equal(body.provider, 'tavily');
  // The graded field must lead with the answer, not with the source list.
  assert.ok(body.summary.startsWith('Argentina won the 2026 FIFA World Cup'));
  assert.match(body.summary, /World Cup final report/);
  assert.equal(body.sources[0].url, 'https://example.com/final');
});

test('web-search: the graded answer field is filled from summary', async (t) => {
  withKey(t);
  stubTavily(t, TAVILY_OK);
  const base = startServer(t);

  // miner.yaml names `answer` as label_field. A route that only sets
  // `summary` still has to come out of the app with `answer` populated,
  // because an empty graded field scores zero however good the JSON is.
  const body = await (await fetch(`${base}/web-search?query=test`)).json();
  assert.equal(body.answer, body.summary);
});

test('web-search: asks Tavily for a written answer, which is the whole point', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/web-search?query=test`);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal(calls[0].headers.Authorization, 'Bearer tvly-test-key');
  assert.equal(calls[0].body.include_answer, 'advanced');
  // basic depth costs one credit against a 1,000/month free allowance;
  // advanced would silently double the burn rate.
  assert.equal(calls[0].body.search_depth, 'basic');
});

test('web-search: a question about current events searches the news index', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/web-search?query=${encodeURIComponent('what are the latest headlines on the election?')}`);
  assert.equal(calls[0].body.topic, 'news');
});

test('web-search: a markets question searches the finance index', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/web-search?query=${encodeURIComponent('what were Nvidia quarterly earnings?')}`);
  assert.equal(calls[0].body.topic, 'finance');
});

test('web-search: an ordinary question searches the general index', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/web-search?query=${encodeURIComponent('how does photosynthesis work?')}`);
  assert.equal(calls[0].body.topic, 'general');
});

test('web-search: an instruction aimed at the miner is stripped before searching', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/web-search?query=${encodeURIComponent('search the web for the boiling point of mercury')}`);
  assert.equal(calls[0].body.query, 'the boiling point of mercury');
});

test('web-search: stripping never leaves an empty search', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  await fetch(`${base}/web-search?query=${encodeURIComponent('look up')}`);
  assert.equal(calls[0].body.query, 'look up');
});

test('web-search: a missing provider answer is composed from the top result', async (t) => {
  withKey(t);
  stubTavily(t, { ...TAVILY_OK, answer: '' });
  const base = startServer(t);
  const body = await (await fetch(`${base}/web-search?query=test`)).json();

  assert.equal(body.status, 'ok');
  assert.match(body.summary, /World Cup final report/);
  assert.match(body.summary, /Argentina lifted the trophy/);
});

test('web-search: nothing matched is an answer, not a failure', async (t) => {
  withKey(t);
  stubTavily(t, { query: 'x', answer: '', results: [], response_time: 0.4 });
  const base = startServer(t);
  const res = await fetch(`${base}/web-search?query=asdkjhasdkjh`);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('web-search: an exhausted provider key reports a real failure', async (t) => {
  withKey(t);
  stubTavily(t, { detail: { error: 'plan limit' } }, { status: 432 });
  const base = startServer(t);
  const res = await fetch(`${base}/web-search?query=test`);

  // Our own outage keeps its failure code rather than being dressed up as
  // an answer, so genuine downtime stays visible in the miner's stats.
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /no credit left/);
});

// Shape verified live against the real API 2026-08-31, not copied from docs.
const PERPLEXITY_OK = {
  choices: [{
    message: {
      role: 'assistant',
      content: 'Mercury boils at about **356.7 °C**, which is 629.9 K.[2][4]',
    },
  }],
  search_results: [
    { title: 'Mercury (element) - Wikipedia', url: 'https://en.wikipedia.org/wiki/Mercury_(element)', snippet: 'Boiling point 629.88 K.' },
  ],
  usage: { cost: { total_cost: 0.00507 } },
};

function stubUpstream(t, handlers) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const handler = Object.entries(handlers).find(([host]) => target.startsWith(host))?.[1];
    if (!handler) return original(url, init);
    calls.push({ url: target, body: JSON.parse(init.body), headers: init.headers });
    // Real fetch rejects with an AbortError when its signal fires. A stub
    // that ignored the signal would let a "hanging provider" test hang
    // forever instead of proving the timeout works.
    const aborted = new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
    const { body, status = 200 } = await Promise.race([handler(calls.length), aborted]);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const PPLX = 'https://api.perplexity.ai';
const TVLY = 'https://api.tavily.com';

test('web-search: perplexity answers and its markdown and citation markers are stripped', async (t) => {
  withKeys(t, { perplexity: 'pplx-test-key' });
  stubUpstream(t, { [PPLX]: () => ({ body: PERPLEXITY_OK }) });
  const base = startServer(t);

  const body = await (await fetch(`${base}/web-search?query=boiling+point+of+mercury`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.provider, 'perplexity');
  // The graded field is compared against a plain ground-truth sentence, so
  // ** and [2][4] must not survive into it.
  assert.ok(!body.summary.includes('**'), 'markdown bold leaked into the graded answer');
  assert.ok(!/\[\d+\]/.test(body.summary), 'citation markers leaked into the graded answer');
  assert.ok(body.summary.startsWith('Mercury boils at about 356.7 °C'));
  assert.equal(body.cost_usd, 0.00507);
});

test('web-search: perplexity is asked for plain prose, which is what the engine grades', async (t) => {
  withKeys(t, { perplexity: 'pplx-test-key' });
  const calls = stubUpstream(t, { [PPLX]: () => ({ body: PERPLEXITY_OK }) });
  const base = startServer(t);
  await fetch(`${base}/web-search?query=test`);

  assert.equal(calls[0].url, 'https://api.perplexity.ai/chat/completions');
  assert.equal(calls[0].body.model, 'sonar');
  assert.match(calls[0].body.messages[0].content, /no markdown/i);
  assert.equal(calls[0].body.messages[1].content, 'test');
});

test('web-search: perplexity leads and tavily is not called when it answers', async (t) => {
  withKeys(t, { perplexity: 'pplx-test-key', tavily: 'tvly-test-key' });
  const calls = stubUpstream(t, {
    [PPLX]: () => ({ body: PERPLEXITY_OK }),
    [TVLY]: () => ({ body: TAVILY_OK }),
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/web-search?query=test`)).json();

  assert.equal(body.provider, 'perplexity');
  assert.equal(calls.length, 1, 'tavily was called even though perplexity answered');
});

test('web-search: tavily picks up the question when perplexity fails', async (t) => {
  withKeys(t, { perplexity: 'pplx-test-key', tavily: 'tvly-test-key' });
  const calls = stubUpstream(t, {
    [PPLX]: () => ({ body: { error: 'boom' }, status: 500 }),
    [TVLY]: () => ({ body: TAVILY_OK }),
  });
  const base = startServer(t);
  const res = await fetch(`${base}/web-search?query=test`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.provider, 'tavily');
  assert.equal(calls.length, 2);
});

test('web-search: both providers failing is a real failure, not a fake answer', async (t) => {
  withKeys(t, { perplexity: 'pplx-test-key', tavily: 'tvly-test-key' });
  stubUpstream(t, {
    [PPLX]: () => ({ body: {}, status: 500 }),
    [TVLY]: () => ({ body: {}, status: 500 }),
  });
  const base = startServer(t);
  const res = await fetch(`${base}/web-search?query=test`);

  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /tavily/);
});

test('web-search: a perplexity answer with no sources is still returned', async (t) => {
  withKeys(t, { perplexity: 'pplx-test-key' });
  stubUpstream(t, { [PPLX]: () => ({ body: { ...PERPLEXITY_OK, search_results: [] } }) });
  const base = startServer(t);
  const body = await (await fetch(`${base}/web-search?query=test`)).json();

  // An answered question must not be discarded for having an empty source
  // list, which would trade a scoring answer for presentation.
  assert.equal(body.status, 'ok');
  assert.equal(body.result_count, 0);
  assert.ok(body.summary.startsWith('Mercury boils'));
});

test('web-search: the whole provider chain stays well inside Telegraph 30s cutoff', async (t) => {
  withKeys(t, { perplexity: 'pplx-test-key', tavily: 'tvly-test-key' });
  // Both providers hang. The chain must abort itself rather than run until
  // the engine cancels the question and books it as a miss.
  stubUpstream(t, {
    [PPLX]: () => new Promise(() => {}),
    [TVLY]: () => new Promise(() => {}),
  });
  const previousBudget = process.env.WEB_SEARCH_BUDGET_MS;
  // Above the chain's own "not worth starting a call" floor, so both
  // providers are genuinely reached rather than skipped.
  process.env.WEB_SEARCH_BUDGET_MS = '3000';
  t.after(() => {
    if (previousBudget === undefined) delete process.env.WEB_SEARCH_BUDGET_MS;
    else process.env.WEB_SEARCH_BUDGET_MS = previousBudget;
  });

  const base = startServer(t);
  const started = Date.now();
  const res = await fetch(`${base}/web-search?query=test`);
  const elapsed = Date.now() - started;

  assert.equal(res.status, 502);
  // The budget is shared across providers rather than given to each, so two
  // hanging providers cost one budget, not two. Anything near double the
  // budget means the per-provider timeouts are stacking, which is exactly
  // what would push a real request past the engine's 30s cutoff.
  assert.ok(elapsed < 5_000, `chain took ${elapsed}ms, which does not respect the shared budget`);
});

test('web-search: a POST body is accepted the same as a query string', async (t) => {
  withKey(t);
  const calls = stubTavily(t, TAVILY_OK);
  const base = startServer(t);
  const res = await fetch(`${base}/web-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'who won the 2026 world cup' }),
  });

  assert.equal(res.status, 200);
  assert.equal(calls[0].body.query, 'who won the 2026 world cup');
});
