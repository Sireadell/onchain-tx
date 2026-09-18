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

function withKey(t, value = 'pplx-test-key') {
  const previous = process.env.PERPLEXITY_API_KEY;
  if (value) process.env.PERPLEXITY_API_KEY = value;
  else delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previous;
  });
}

function stubPerplexity(t, content) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }],
      usage: { cost: { total_cost: 0.001 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('content-moderate: missing text answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/content-moderate`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('content-moderate: a safe message is reported safe', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Safe. No policy violation was found.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/content-moderate?text=have+a+nice+day`)).json();

  assert.equal(body.status, 'ok');
  assert.equal(body.flagged, false);
  assert.equal(body.confidence, 0.9);
});

test('content-moderate: a flagged message is reported flagged', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Flagged. The text contains a direct threat of violence.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/content-moderate?text=something+bad`)).json();

  assert.equal(body.status, 'ok');
  assert.equal(body.flagged, true);
});

test('content-moderate: a Flagged label on a "no concern" reason is read as Safe', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Flagged. This appears to be a query about a clinical trial and does not indicate violence, hate, or illegal activity.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/content-moderate?text=${encodeURIComponent('Will SHR-4610 injection complete Phase 1?')}`)).json();
  assert.equal(body.flagged, false);
  assert.match(body.summary, /^Safe\. This appears to be a query/);
});

test('content-moderate: a real concern stays Flagged even when the reason contains "not"', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Flagged. The text threatens violence, but it does not name a specific person.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/content-moderate?text=${encodeURIComponent('I will hurt someone')}`)).json();
  assert.equal(body.flagged, true);
});

test('content-moderate: competitor param names are accepted and the text is framed', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Safe. No concern was found.');
  const base = startServer(t);
  for (const qs of ['content=have+a+nice+day', 'message=have+a+nice+day', 'comment=have+a+nice+day', 'post=have+a+nice+day', 'q=have+a+nice+day']) {
    const body = await (await fetch(`${base}/content-moderate?${qs}`)).json();
    assert.equal(body.status, 'ok', qs);
    assert.equal(body.flagged, false, qs);
  }
  assert.equal(calls[0].body.input[0].content, '<<<TEXT>>>\nhave a nice day\n<<<END>>>');
  assert.equal(calls[0].body.tools, undefined);
});

test('content-moderate: a huge text is capped and a provider failure is a real 502', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Safe. Nothing found.');
  const base = startServer(t);
  const res = await fetch(`${base}/content-moderate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(20000) }),
  });
  assert.equal(res.status, 200);
  assert.ok(calls[0].body.input[0].content.length < 12100);

  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    return new Response('{}', { status: 503 });
  };
  t.after(() => { globalThis.fetch = original; });
  const down = await fetch(`${base}/content-moderate?text=hello`);
  assert.equal(down.status, 502);
});
