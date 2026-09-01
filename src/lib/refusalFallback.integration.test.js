// End-to-end tests for the refusal fallback, driven through the REAL app
// (buildApp) over a real HTTP socket rather than a fake req/res pair.
//
// refusalFallback.test.js exercises the middleware in isolation. That misses
// everything this file is for: the three res.json wrappers composing in the
// order app.js mounts them, express's own path matching, the misroute
// handoff re-dispatching into a different handler, HTTP framing (a second
// write is a protocol error, not a counter going to 2), and what the scorer
// actually reads off the wire.
//
// No real network calls to any search provider are made. globalThis.fetch is
// replaced with a router that serves the stubbed upstreams and delegates
// loopback traffic (this file's own client requests) to the real fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { resetRescueCap } from './refusalFallback.js';
import { searchWeb } from './webSearch.js';

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Process-level safety net. An unhandled rejection or uncaught exception in
// this service is catastrophic: one Node process serves all 14 intents. These
// listeners stop node:test tearing the run down so each test can assert on
// them by name instead.
// ---------------------------------------------------------------------------
const processFaults = [];
process.on('unhandledRejection', (err) => processFaults.push({ kind: 'unhandledRejection', err }));
process.on('uncaughtException', (err) => processFaults.push({ kind: 'uncaughtException', err }));

function faultsSince(mark) {
  return processFaults.slice(mark).map((f) => `${f.kind}: ${f.err?.code ?? ''} ${f.err?.message ?? f.err}`);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function startServer(t, build = buildApp) {
  const app = build();
  const server = app.listen(0);
  const errors = [];
  server.on('error', (err) => errors.push(err));
  server.on('clientError', (err) => errors.push(err));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, errors };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Mirrors what undici does: an aborted signal rejects the in-flight call with
// an AbortError. A stub that ignored the signal would test a fetch that does
// not exist and would hide any missing timeout.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      const err = new Error('aborted');
      err.name = 'AbortError';
      return reject(err);
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
}

// routes: array of [substringOfUrl, async (url, init) => Response]
function stubFetch(t, routes) {
  const unstubbed = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) return realFetch(input, init);
    for (const [needle, handler] of routes) {
      if (url.includes(needle)) return handler(url, init);
    }
    unstubbed.push(url);
    return jsonResponse({ error: 'unstubbed' }, 599);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return unstubbed;
}

// A Perplexity stub that records every call it receives, so a test can assert
// both that it was called and exactly what prompt it was sent.
function perplexityStub({ answer = 'Russia has not declared total war.', delayMs = 10, hang = false } = {}) {
  const calls = [];
  const handler = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, prompt: body.messages.find((m) => m.role === 'user')?.content });
    if (hang) {
      await delay(600_000, init.signal);
    } else {
      await delay(delayMs, init.signal);
    }
    return jsonResponse({
      choices: [{ message: { content: answer } }],
      search_results: [{ title: 'Reuters', url: 'https://reuters.com/x', snippet: 's' }],
      usage: { cost: { total_cost: 0.005 } },
    });
  };
  return { calls, route: ['api.perplexity.ai', handler] };
}

function withProviderKey(t, { perplexity = 'test-key', tavily = null } = {}) {
  const before = {
    p: process.env.PERPLEXITY_API_KEY,
    tv: process.env.TAVILY_API_KEY,
    budget: process.env.WEB_SEARCH_BUDGET_MS,
  };
  if (perplexity) process.env.PERPLEXITY_API_KEY = perplexity;
  else delete process.env.PERPLEXITY_API_KEY;
  if (tavily) process.env.TAVILY_API_KEY = tavily;
  else delete process.env.TAVILY_API_KEY;
  delete process.env.WEB_SEARCH_BUDGET_MS;
  resetRescueCap();
  t.after(() => {
    if (before.p === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = before.p;
    if (before.tv === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = before.tv;
    if (before.budget === undefined) delete process.env.WEB_SEARCH_BUDGET_MS; else process.env.WEB_SEARCH_BUDGET_MS = before.budget;
    resetRescueCap();
  });
}

// The scorer reads bytes, not a parsed object, so tests read the raw text and
// parse it themselves. A second write onto the same response shows up here as
// trailing bytes after the first JSON document rather than as valid JSON.
async function getRaw(url, init) {
  const res = await realFetch(url, init);
  const text = await res.text();
  return { res, text, body: JSON.parse(text) };
}

const NON_WEATHER_QUESTION = 'Is total war now in Russia?';

// ---------------------------------------------------------------------------
// 1. The graded field. This is the assertion the whole change exists for.
// ---------------------------------------------------------------------------

test('integration: after a rescue the wire `answer` is the rescued sentence', async (t) => {
  withProviderKey(t);
  const px = perplexityStub({ answer: 'Russia has not declared total war.' });
  stubFetch(t, [px.route]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  const { res, body } = await getRaw(`${base}/weather-forecast?q=${encodeURIComponent(NON_WEATHER_QUESTION)}`);

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok', 'a rescued refusal must not still read invalid_input');
  assert.equal(body.answered_by_fallback, true);
  assert.equal(px.calls.length, 1, 'the search must run exactly once');

  // The graded field, checked directly rather than via summary.
  assert.equal(typeof body.answer, 'string');
  assert.ok(body.answer.length > 0, '`answer` must not be empty');
  assert.match(body.answer, /Russia has not declared total war/, '`answer` must carry the rescued sentence');
  assert.doesNotMatch(body.answer, /does not appear to ask about weather/, '`answer` must not still be the refusal text');
  assert.equal(body.answer, body.summary);
  assert.equal(body.confidence, 0.9);
  assert.equal(body.provider, 'perplexity');

  assert.deepEqual(errors, []);
  assert.deepEqual(faultsSince(mark), []);
});

test('integration: a rescue over POST with a JSON body reaches the wire the same way', async (t) => {
  withProviderKey(t);
  const px = perplexityStub({ answer: 'The Voyager 1 probe is still transmitting.' });
  stubFetch(t, [px.route]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  const question = 'Is Voyager 1 still transmitting?';
  const { res, body } = await getRaw(`${base}/weather-forecast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, chain: 'ethereum', tx_hash: `0x${'a'.repeat(64)}` }),
  });

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.answer, /Voyager 1 is still transmitting|still transmitting/);
  assert.equal(body.answer, body.summary);

  // Only the question is sent to the provider, not a join of every param.
  assert.equal(px.calls.length, 1);
  assert.equal(px.calls[0].prompt, question,
    `the search prompt must be the question alone, got ${JSON.stringify(px.calls[0].prompt)}`);

  assert.deepEqual(errors, []);
  assert.deepEqual(faultsSince(mark), []);
});

test('integration: exactly one body is written for a rescued request', async (t) => {
  withProviderKey(t);
  const px = perplexityStub();
  stubFetch(t, [px.route]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  const { res, text } = await getRaw(`${base}/weather-forecast?q=${encodeURIComponent(NON_WEATHER_QUESTION)}`);

  // Trailing bytes after the first JSON document would mean a second write.
  const parsed = JSON.parse(text);
  assert.equal(JSON.stringify(parsed).length > 0, true);
  assert.equal(text.trim().endsWith('}'), true);
  assert.equal((text.match(/"answered_by_fallback"/g) ?? []).length, 1, 'exactly one body on the wire');
  const declared = res.headers.get('content-length');
  if (declared != null) {
    assert.equal(Number(declared), Buffer.byteLength(text), 'content-length must match the bytes actually sent');
  }

  assert.deepEqual(errors, [], 'no ERR_HTTP_HEADERS_SENT / framing error on the server');
  assert.deepEqual(faultsSince(mark), []);
});

// ---------------------------------------------------------------------------
// 2. The two #1-ranked intents must not regress.
// ---------------------------------------------------------------------------

// checked_at is a timestamp taken at response time, so it is the one field
// that legitimately differs between two runs. Everything else, including key
// order, must be byte-identical.
function normaliseTimestamps(text) {
  return text.replace(/"checked_at":"[^"]*"/g, '"checked_at":"<T>"')
    .replace(/"days_until_expiry":-?\d+/g, '"days_until_expiry":<N>');
}

// The two byte-for-byte comparisons that lived here were run once, against
// a frozen copy of app.js from before this change, and both passed: the
// successful /ip-geolocate and /ssl-check bodies were identical key for
// key. They are not kept, because the frozen copy goes stale the moment
// app.js changes again and would then fail for the wrong reason. The two
// tests below cover the risk that actually matters: neither #1-ranked
// route is ever rescued.
test('integration: a genuine /ip-geolocate provider outage still refuses and is never rescued', async (t) => {
  withProviderKey(t);
  const px = perplexityStub();
  stubFetch(t, [
    px.route,
    ['ipinfo.io', async () => jsonResponse({ error: { message: 'down' } }, 500)],
    ['ip-api.com', async () => jsonResponse({ status: 'fail', message: 'down' })],
  ]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  const { res, body } = await getRaw(`${base}/ip-geolocate?q=${encodeURIComponent('Where is 8.8.8.8 located?')}`);

  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input', 'a real outage must keep reading as a refusal, not a confident guess');
  assert.equal(body.answered_by_fallback, undefined);
  assert.equal(px.calls.length, 0, '#1-ranked IP_GEOLOCATION must never reach the search');
  assert.deepEqual(errors, []);
  assert.deepEqual(faultsSince(mark), []);
});

test('integration: an /ssl-check refusal is never rescued', async (t) => {
  withProviderKey(t);
  const px = perplexityStub();
  stubFetch(t, [px.route]);
  const { base } = startServer(t);
  const mark = processFaults.length;

  const { res, body } = await getRaw(`${base}/ssl-check?domain=${encodeURIComponent('Is this thing secure?')}`);
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
  assert.equal(px.calls.length, 0, '#1-ranked SSL_VERIFICATION must never reach the search');
  assert.deepEqual(faultsSince(mark), []);
});

// ---------------------------------------------------------------------------
// 3. Path matching. Express matches routes case-insensitively and tolerates a
//    trailing slash, so the skip list has to as well or the exclusion is
//    decorative.
// ---------------------------------------------------------------------------

// maxOwnSearches: /web-search legitimately calls the provider once itself, so
// the skip list is proved there by the ABSENCE of a second call, not by zero.
for (const [path, maxOwnSearches] of [
  ['/IP-Geolocate', 0],
  ['/ip-geolocate/', 0],
  ['/IP-GEOLOCATE/', 0],
  ['/Ssl-Check/', 0],
  ['/Web-Search/', 1],
  ['/web-search/', 1],
]) {
  test(`integration: ${path} is still excluded from the search`, async (t) => {
    withProviderKey(t);
    const px = perplexityStub();
    stubFetch(t, [
      px.route,
      ['ipinfo.io', async () => jsonResponse({ error: { message: 'down' } }, 500)],
      ['ip-api.com', async () => jsonResponse({ status: 'fail', message: 'down' })],
    ]);
    const { base, errors } = startServer(t);
    const mark = processFaults.length;

    // A question-shaped, non-quoting input, i.e. exactly what would be
    // rescued on any non-excluded route.
    const q = encodeURIComponent('Where is 8.8.8.8 located?');
    const { res, body } = await getRaw(`${base}${path}?q=${q}`);

    assert.ok(res.status < 600, `unexpected status ${res.status}`);
    assert.equal(px.calls.length <= maxOwnSearches, true,
      `${path} reached the fallback search despite being on the skip list (${px.calls.length} calls)`);
    assert.equal(body.answered_by_fallback, undefined, `${path} was rescued despite being on the skip list`);
    assert.deepEqual(errors, []);
    assert.deepEqual(faultsSince(mark), []);
  });
}

// ---------------------------------------------------------------------------
// 4. Failures that must NOT be rescued.
// ---------------------------------------------------------------------------

test('integration: a real 5xx outage keeps its status and is not rescued', async (t) => {
  withProviderKey(t);
  const px = perplexityStub();
  stubFetch(t, [
    px.route,
    ['api.openalex.org', async () => jsonResponse({ error: 'down' }, 503)],
    ['api.crossref.org', async () => jsonResponse({ error: 'down' }, 503)],
  ]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  const q = encodeURIComponent('What research papers exist on federated learning?');
  const { res, body } = await getRaw(`${base}/academic-search?q=${q}`);

  assert.equal(res.status, 502, 'downtime must keep a real failure code');
  assert.equal(body.status, 'error');
  assert.equal(body.answered_by_fallback, undefined);
  assert.equal(px.calls.length, 0, 'a 5xx must never be turned into a confident answer');
  assert.deepEqual(errors, []);
  assert.deepEqual(faultsSince(mark), []);
});

test('integration: a refusal that quotes the caller\'s own input is kept as-is', async (t) => {
  withProviderKey(t);
  const px = perplexityStub();
  stubFetch(t, [
    px.route,
    // The geocoder resolves nothing, so the route raises WeatherLookupError
    // and answers with the caller's own value quoted back.
    ['geocoding-api.open-meteo.com', async () => jsonResponse({ results: [] })],
  ]);
  const { base } = startServer(t);
  const mark = processFaults.length;

  // Weather-shaped, so it passes the intent guard, but names no resolvable
  // place, so the route quotes the input back. That reply is more useful to
  // the dispatcher than a guess from a general web model.
  const { res, body } = await getRaw(`${base}/weather-forecast?q=${encodeURIComponent('Will it rain tomorrow in Zzqxwv?')}`);

  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /"/);
  assert.equal(px.calls.length, 0);
  assert.deepEqual(faultsSince(mark), []);
});

// ---------------------------------------------------------------------------
// 5. The misroute handoff, which re-dispatches into a different handler on the
//    same res that all three wrappers are already holding.
// ---------------------------------------------------------------------------

test('integration: a handed-off request that then refuses sends exactly one body', async (t) => {
  withProviderKey(t);
  const px = perplexityStub();
  stubFetch(t, [
    px.route,
    ['ipinfo.io', async () => jsonResponse({ error: { message: 'down' } }, 500)],
    ['ip-api.com', async () => jsonResponse({ status: 'fail', message: 'down' })],
  ]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  // /ssl-check hands an IP-location question to the IP handler (misrouteHandoff),
  // which then refuses because both geolocation providers are down.
  const q = encodeURIComponent('Where is 8.8.8.8 located?');
  const { res, text, body } = await getRaw(`${base}/ssl-check?domain=${q}`);

  assert.equal(res.status, 200);
  assert.equal(typeof body, 'object');
  assert.equal((text.match(/"status"/g) ?? []).length >= 1, true);
  assert.equal(text.trim().endsWith('}'), true, 'no second body appended');
  assert.deepEqual(errors, [], 'the handoff must not produce a framing error');
  assert.deepEqual(faultsSince(mark), []);
});

test('integration: a handed-off request on a rescuable route does not crash or double-send', async (t) => {
  withProviderKey(t);
  const px = perplexityStub();
  stubFetch(t, [px.route]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  // A balance question sent to /token-holders is handed to the wallet handler.
  const q = encodeURIComponent(`What is the balance of 0x${'a'.repeat(40)}?`);
  const { res, text } = await getRaw(`${base}/token-holders?q=${q}`);

  assert.ok([200, 502, 503].includes(res.status), `unexpected status ${res.status}`);
  const parsed = JSON.parse(text);
  assert.equal(typeof parsed, 'object');
  assert.equal(text.trim().endsWith('}'), true, 'no second body appended');
  assert.deepEqual(errors, []);
  assert.deepEqual(faultsSince(mark), []);
});

// ---------------------------------------------------------------------------
// 6. Time. Telegraph cuts a response at 30s measured at the dispatcher, so a
//    slow provider must not be able to hold the socket open.
// ---------------------------------------------------------------------------

test('integration: a hung search still answers well inside the request deadline', async (t) => {
  withProviderKey(t);
  const px = perplexityStub({ hang: true });
  stubFetch(t, [px.route]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  const started = Date.now();
  const { res, body } = await getRaw(`${base}/weather-forecast?q=${encodeURIComponent(NON_WEATHER_QUESTION)}`);
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input', 'a hung search must fall back to the original refusal');
  assert.ok(elapsed < 15_000, `response took ${elapsed}ms, past the 15s request deadline`);
  assert.equal(px.calls.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(faultsSince(mark), []);
});

test('integration: the search budget shrinks by however long the route already spent', async (t) => {
  // The worry the budgets were cut for: a route can burn MAX_ANALYSIS_TIME_MS
  // (12s, ankrRpc.js) before it refuses. The search must get the REMAINING
  // time, not a fresh 5s on top. Scaled down so the test is fast; the clamp
  // is the same arithmetic at either size.
  const { createRefusalFallbackMiddleware } = await import('./refusalFallback.js');
  resetRescueCap();
  const calls = [];
  const mw = createRefusalFallbackMiddleware({
    search: async (q, opts) => { calls.push(opts); return { answer: 'x', results: [], provider: 'p' }; },
    hasProvider: () => true,
    searchBudgetMs: 5_000,
    deadlineMs: 1_500,
    minUsefulMs: 100,
  });
  const res = { sent: null, writableEnded: false, headersSent: false, destroyed: false, on() {}, json(b) { this.sent = b; return this; } };
  mw({ path: '/weather-forecast', method: 'GET', query: { q: NON_WEATHER_QUESTION }, originalUrl: '/weather-forecast' }, res, () => {});

  await new Promise((r) => setTimeout(r, 1_000)); // the route "spends" 1s
  res.json({ status: 'invalid_input', summary: 'no quotes here', confidence: 1 });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(calls.length, 1);
  assert.ok(calls[0].budgetMs <= 600,
    `search was given ${calls[0].budgetMs}ms after 1000ms of a 1500ms deadline was already spent`);
  assert.ok(calls[0].budgetMs > 0);
});

test('integration: the hourly rescue cap stops paying for runaway traffic', async (t) => {
  withProviderKey(t);
  const px = perplexityStub({ delayMs: 1 });
  stubFetch(t, [px.route]);
  const { base } = startServer(t);
  const mark = processFaults.length;

  let rescued = 0;
  for (let i = 0; i < 65; i += 1) {
    const { body } = await getRaw(`${base}/weather-forecast?q=${encodeURIComponent(`Is fact number ${i} true?`)}`);
    if (body.answered_by_fallback) rescued += 1;
    else assert.equal(body.status, 'invalid_input', 'a request past the cap must fall back to the plain refusal');
  }

  assert.equal(rescued, 60, `expected the cap to hold at 60 rescues, saw ${rescued}`);
  assert.equal(px.calls.length, 60, 'no paid call may be made past the cap');
  assert.deepEqual(faultsSince(mark), []);
});

// ---------------------------------------------------------------------------
// 7. Crash hunting: a client that hangs up while the detached search is still
//    running is the one way this change can write onto a dead socket.
// ---------------------------------------------------------------------------

test('integration: a client that aborts mid-search does not take the process down', async (t) => {
  withProviderKey(t);
  const px = perplexityStub({ delayMs: 400 });
  stubFetch(t, [px.route]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  const controller = new AbortController();
  const pending = realFetch(`${base}/weather-forecast?q=${encodeURIComponent(NON_WEATHER_QUESTION)}`, {
    signal: controller.signal,
  }).catch(() => 'aborted');
  await new Promise((r) => setTimeout(r, 60));
  controller.abort();
  assert.equal(await pending, 'aborted');

  // Give the detached search time to settle and try to write onto the dead socket.
  await new Promise((r) => setTimeout(r, 1200));

  assert.deepEqual(faultsSince(mark), [], 'a hung-up client must not produce an unhandled fault');
  assert.deepEqual(errors, []);

  // And the server is still serving.
  const px2 = perplexityStub({ answer: 'Still alive.' });
  stubFetch(t, [px2.route]);
  const after = await getRaw(`${base}/weather-forecast?q=${encodeURIComponent('Is the server alive?')}`);
  assert.equal(after.res.status, 200);
  assert.equal(after.body.status, 'ok');
  assert.match(after.body.answer, /Still alive/);
});

test('integration: twenty concurrent rescues all answer, once each, with no faults', async (t) => {
  withProviderKey(t);
  const px = perplexityStub({ delayMs: 30 });
  stubFetch(t, [px.route]);
  const { base, errors } = startServer(t);
  const mark = processFaults.length;

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => getRaw(
    `${base}/weather-forecast?q=${encodeURIComponent(`Is question number ${i} answerable?`)}`,
  )));

  for (const r of results) {
    assert.equal(r.res.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.answer, r.body.summary);
    assert.ok(r.body.answer.length > 0);
    assert.equal(r.text.trim().endsWith('}'), true);
  }
  assert.equal(px.calls.length, 20, 'one search per rescued request, no duplicates');
  assert.deepEqual(errors, []);
  assert.deepEqual(faultsSince(mark), []);
});

// ---------------------------------------------------------------------------
// 8. Regression guard on the WEB_SEARCH intent itself. The budget precedence
//    in webSearch.js was changed in the same commit as this middleware, and
//    /web-search calls searchWeb with no budgetMs of its own.
// ---------------------------------------------------------------------------

test('integration: /web-search still answers when no budget env var is set', async (t) => {
  withProviderKey(t); // deletes WEB_SEARCH_BUDGET_MS
  const px = perplexityStub({ answer: 'The capital of France is Paris.', delayMs: 60 });
  stubFetch(t, [px.route]);
  const { base } = startServer(t);
  const mark = processFaults.length;

  const { res, body } = await getRaw(`${base}/web-search?q=${encodeURIComponent('What is the capital of France?')}`);

  assert.equal(res.status, 200, `WEB_SEARCH returned ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'ok');
  assert.match(body.answer, /Paris/);
  assert.deepEqual(faultsSince(mark), []);
});

// Regression test for the precedence fix in webSearch.js. The old expression
// read WEB_SEARCH_BUDGET_MS first, so a value tuned for /web-search would
// override the fallback's own remaining-time budget. That budget is what
// keeps a rescue inside Telegraph's 30s cut, so it must win.
//
// 3s, not something tiny: webSearch has its own MIN_USEFUL_MS of 2.5s and
// will not call a provider at all below it, which would prove nothing about
// precedence.
test("integration: an env budget never overrides the caller's own tighter budget", async (t) => {
  withProviderKey(t);
  process.env.WEB_SEARCH_BUDGET_MS = '600000';
  const px = perplexityStub({ hang: true });
  stubFetch(t, [px.route]);
  const mark = processFaults.length;

  const startedAt = Date.now();
  await assert.rejects(
    () => searchWeb('Is total war now in Russia?', { budgetMs: 3_000 }),
    'a provider that never answers must fail rather than invent one'
  );
  const elapsed = Date.now() - startedAt;

  assert.equal(px.calls.length, 1, 'the provider must actually have been called');
  assert.ok(elapsed < 15_000, `caller budget must bound the search, took ${elapsed}ms`);
  assert.deepEqual(faultsSince(mark), []);
});
