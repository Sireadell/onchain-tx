import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefusalFallbackMiddleware, resetRescueCap } from './refusalFallback.js';
import { UNUSABLE_INPUT_STATUS } from './unusableInput.js';

const REFUSAL = {
  status: UNUSABLE_INPUT_STATUS,
  summary: 'I cannot answer that from a weather forecast.',
  confidence: 1.0,
};

function fakeRes() {
  return {
    sent: null,
    sendCount: 0,
    writableEnded: false,
    headersSent: false,
    destroyed: false,
    on() { return this; },
    json(body) {
      this.sent = body;
      this.sendCount += 1;
      this.writableEnded = true;
      return this;
    },
  };
}

function fakeReq(path, params, method = 'GET') {
  return method === 'GET'
    ? { path, method, query: params }
    : { path, method, body: params };
}

// The rescue is detached from res.json on purpose, so a test has to wait for
// it to settle rather than assume it ran synchronously.
async function settled(res, timeoutMs = 1000) {
  const until = Date.now() + timeoutMs;
  while (res.sent === null && Date.now() < until) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return res.sent;
}

function answeringSearch(answer = 'Russia has not declared total war.') {
  const calls = [];
  const search = async (query, options) => {
    calls.push({ query, options });
    return { answer, results: [{ title: 'Reuters', url: 'https://reuters.com/x' }], provider: 'perplexity' };
  };
  return { search, calls };
}

const QUESTION = 'Is total war now in Russia?';

test('fallback: a refused question is answered from the web instead', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);
  const body = await settled(res);

  assert.equal(body.status, 'ok');
  assert.equal(body.answered_by_fallback, true);
  assert.match(body.summary, /Russia has not declared total war/);
  // The engine grades `answer`, so it must carry the rescued sentence.
  assert.equal(body.answer, body.summary);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, QUESTION);
  assert.equal(res.sendCount, 1);
});

test('fallback: a search failure leaves the original refusal untouched', async () => {
  resetRescueCap();
  const search = async () => { throw new Error('perplexity is down'); };
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);
  const body = await settled(res);

  assert.deepEqual(body, REFUSAL);
  assert.equal(res.sendCount, 1);
});

test('fallback: a search that finds nothing leaves the refusal untouched', async () => {
  resetRescueCap();
  const search = async () => ({ answer: null, results: [], provider: null });
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);
  const body = await settled(res);

  assert.deepEqual(body, REFUSAL);
});

test('fallback: a normal answer is passed straight through', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/gas-price', { q: 'What is gas on Ethereum?' }), res, () => {});
  const ok = { status: 'ok', summary: 'Gas is 12 gwei.', confidence: 1 };
  res.json(ok);

  assert.deepEqual(res.sent, ok);
  assert.equal(calls.length, 0, 'a successful answer must never call the search');
});

test('fallback: a genuine outage keeps its failure status', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/gas-price', { q: 'What is gas on Ethereum?' }), res, () => {});
  const outage = { status: 'error', summary: 'upstream RPC call failed', confidence: 1 };
  res.json(outage);

  assert.deepEqual(res.sent, outage);
  assert.equal(calls.length, 0, 'reporting downtime as an answer would hide it');
});

test('fallback: a malformed parameter keeps its helpful refusal', async () => {
  // Not question-shaped, so the reply naming the broken parameter is more
  // use to the caller than anything a web model would guess.
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  let nexted = false;
  mw(fakeReq('/wallet-balance', { address: '0xabc' }), res, () => { nexted = true; });
  res.json(REFUSAL);

  assert.equal(nexted, true);
  assert.deepEqual(res.sent, REFUSAL);
  assert.equal(calls.length, 0);
});

test('fallback: web-search is skipped so one question is not searched twice', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/web-search', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);

  assert.deepEqual(res.sent, REFUSAL);
  assert.equal(calls.length, 0);
});

test('fallback: nothing is searched when no provider is configured', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => false });
  const res = fakeRes();
  mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);

  assert.deepEqual(res.sent, REFUSAL);
  assert.equal(calls.length, 0);
});

test('fallback: too little time left means the refusal goes out immediately', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  // A deadline already spent leaves nothing for a search that has never
  // answered in under 1.8s.
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true, deadlineMs: 0 });
  const res = fakeRes();
  mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);

  assert.deepEqual(res.sent, REFUSAL);
  assert.equal(calls.length, 0);
});

test('fallback: the search is given the remaining budget, never more', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({
    search,
    hasProvider: () => true,
    searchBudgetMs: 20_000,
    deadlineMs: 27_000,
  });
  const res = fakeRes();
  mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);
  await settled(res);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.budgetMs <= 20_000, 'never exceeds the search budget');
  assert.ok(calls[0].options.budgetMs > 0);
});

test('fallback: a second res.json never produces a second send', async () => {
  resetRescueCap();
  const { search } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);
  res.json(REFUSAL);
  res.json({ status: 'ok', summary: 'something else' });
  await settled(res);

  assert.equal(res.sendCount, 1);
});

test('fallback: a client that hung up mid-search is not written to', async () => {
  resetRescueCap();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  resetRescueCap();
  const search = async () => { await gate; return { answer: 'late', results: [], provider: 'perplexity' }; };
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
  res.json(REFUSAL);
  // The connection drops while the search is still running.
  res.writableEnded = true;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(res.sendCount, 0);
});

test('fallback: the two #1-ranked intents are never rescued', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  for (const path of ['/ip-geolocate', '/ssl-check']) {
    const res = fakeRes();
    mw(fakeReq(path, { q: QUESTION }), res, () => {});
    res.json(REFUSAL);
    assert.deepEqual(res.sent, REFUSAL, `${path} must be left alone`);
  }
  assert.equal(calls.length, 0);
});

test('fallback: the skip list survives a trailing slash and odd casing', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  for (const path of ['/web-search/', '/Web-Search', '/IP-Geolocate/']) {
    const res = fakeRes();
    mw(fakeReq(path, { q: QUESTION }), res, () => {});
    res.json(REFUSAL);
    assert.deepEqual(res.sent, REFUSAL, `${path} must still be skipped`);
  }
  assert.equal(calls.length, 0, 'a skipped path must never reach the search');
});

test('fallback: a refusal naming the caller\'s own bad value is kept', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  // Question-shaped input, but the refusal quotes what was wrong with it.
  // That sentence tells the dispatcher what to send next; a guess does not.
  mw(fakeReq('/wallet-balance', { q: 'What is the balance of 0xabc?' }), res, () => {});
  res.json({
    status: UNUSABLE_INPUT_STATUS,
    summary: 'I cannot read a balance because "0xabc" is not a valid wallet address.',
    confidence: 1.0,
  });

  assert.equal(res.sent.status, UNUSABLE_INPUT_STATUS);
  assert.equal(calls.length, 0);
});

test('fallback: rescues stop at the hourly cap', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true, maxRescuesPerHour: 2 });
  const bodies = [];
  for (let i = 0; i < 4; i += 1) {
    const res = fakeRes();
    mw(fakeReq('/weather-forecast', { q: QUESTION }), res, () => {});
    res.json(REFUSAL);
    bodies.push(await settled(res));
  }
  assert.equal(calls.length, 2, 'only two rescues are paid for');
  assert.equal(bodies[2].status, UNUSABLE_INPUT_STATUS, 'the third refuses as normal');
  assert.equal(bodies[3].status, UNUSABLE_INPUT_STATUS);
});

test('fallback: the search gets the question, not every parameter joined', async () => {
  resetRescueCap();
  const { search, calls } = answeringSearch();
  const mw = createRefusalFallbackMiddleware({ search, hasProvider: () => true });
  const res = fakeRes();
  mw(fakeReq('/check-tx', {
    question: 'Is total war now in Russia?',
    chain: 'ethereum',
    tx_hash: '0xdeadbeef',
  }, 'POST'), res, () => {});
  res.json(REFUSAL);
  await settled(res);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'Is total war now in Russia?');
  assert.ok(!calls[0].query.includes('ethereum'), 'parameters must not pollute the search');
  assert.ok(!calls[0].query.includes('0xdeadbeef'));
});
