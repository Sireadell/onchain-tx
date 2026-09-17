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

// Stubs one or more target URLs. Each entry is { html, status, contentType,
// headers }. Requests to anything else fall through to the real fetch.
function stubPages(t, pages) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const key = String(url);
    const page = pages[key];
    if (!page) return original(url, init);
    calls.push({ url: key, redirect: init?.redirect });
    const { html = '', status = 200, contentType = 'text/html; charset=utf-8', headers = {} } = page;
    return new Response(html, { status, headers: { 'content-type': contentType, ...headers } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function stubPage(t, targetUrl, spec = {}) {
  return stubPages(t, { [targetUrl]: spec });
}

// The passage path may call the LLM; stub it out so the tests are
// deterministic and free. The route falls back to the heuristic
// extraction when the provider is absent.
function withoutLlm(t) {
  const previous = process.env.PERPLEXITY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => { if (previous !== undefined) process.env.PERPLEXITY_API_KEY = previous; });
}

test('content-extract: missing url answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/content-extract`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('content-extract: private, loopback, link-local, IPv6 and non-http targets are refused, not fetched', async (t) => {
  const base = startServer(t);
  const calls = stubPages(t, {});
  for (const target of [
    'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:3999/health', 'http://localhost/admin',
    'http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/', 'http://0.0.0.0/',
    'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://metadata.google.internal/',
    'http://db.internal/', 'http://printer.local/', 'ftp://example.com/x', 'file:///etc/passwd',
  ]) {
    const res = await fetch(`${base}/content-extract?url=${encodeURIComponent(target)}`);
    assert.equal(res.status, 200, target);
    const body = await res.json();
    assert.equal(body.status, 'invalid_input', target);
  }
  assert.equal(calls.length, 0, 'a blocked target was fetched');
});

test('content-extract: a redirect into a private address is refused at the hop', async (t) => {
  const target = 'https://example.com/go';
  const calls = stubPages(t, {
    [target]: { html: '', status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
  });
  const base = startServer(t);
  const res = await fetch(`${base}/content-extract?url=${encodeURIComponent(target)}`);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /private or internal address/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'manual');
});

test('content-extract: a public redirect is followed and the final page extracted', async (t) => {
  stubPages(t, {
    'https://example.com/old': { html: '', status: 301, headers: { location: 'https://example.com/new' } },
    'https://example.com/new': { html: '<html><head><title>New Home</title></head><body><p>Moved here.</p></body></html>' },
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/content-extract?url=${encodeURIComponent('https://example.com/old')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.title, 'New Home');
  assert.equal(body.final_url, 'https://example.com/new');
});

test('content-extract: returns the page title and readable text', async (t) => {
  const target = 'https://example.com/article';
  stubPage(t, target, {
    html: '<html><head><title>My Article</title></head><body><script>evil()</script><p>Hello world.</p><p>Second paragraph.</p></body></html>',
  });
  const base = startServer(t);
  const res = await fetch(`${base}/content-extract?url=${encodeURIComponent(target)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.title, 'My Article');
  assert.match(body.text, /Hello world\./);
  assert.match(body.text, /Second paragraph\./);
  assert.ok(!body.text.includes('evil()'), 'script contents leaked into extracted text');
  assert.match(body.summary, /^"My Article": Hello world\. Second paragraph\./);
});

test('content-extract: a URL inside a sentence, a bare host, and the link/question/query aliases all work', async (t) => {
  const target = 'https://example.com/';
  stubPage(t, target, { html: '<title>Example Domain</title><p>This domain is for use in documentation examples.</p>' });
  const base = startServer(t);
  for (const qs of [
    `url=${encodeURIComponent('extract from https://example.com/')}`,
    `link=${encodeURIComponent(target)}`,
    `question=${encodeURIComponent('what does https://example.com/ say?')}`,
    `query=${encodeURIComponent(target)}`,
    `url=${encodeURIComponent('example.com/')}`,
  ]) {
    const body = await (await fetch(`${base}/content-extract?${qs}`)).json();
    assert.equal(body.status, 'ok', qs);
    assert.equal(body.url, target, qs);
  }
});

test('content-extract: a login-walled page leads with its meta description', async (t) => {
  const target = 'https://www.instagram.com/reels/abc/';
  stubPage(t, target, {
    html: '<html><head><title>Instagram</title><meta property="og:title" content="Aman Rawat on Instagram: NOT IN THE BLOOD SIR">'
      + '<meta property="og:description" content="450K likes, 420 comments - aman_rawatt_ on July 23, 2026: NOT IN THE BLOOD SIR #motivation">'
      + '</head><body><a>Log In</a><a>Sign Up</a></body></html>',
  });
  const base = startServer(t);
  const body = await (await fetch(`${base}/content-extract?url=${encodeURIComponent(target)}`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /450K likes, 420 comments/);
  assert.match(body.description, /450K likes/);
  assert.ok(body.confidence < 0.95, 'thin page should carry lower confidence');
});

test('content-extract: plain text is extracted; a PDF or image is refused honestly', async (t) => {
  stubPages(t, {
    'https://example.com/notes.txt': { html: 'line one\nline two', contentType: 'text/plain' },
    'https://example.com/paper.pdf': { html: '%PDF-1.4', contentType: 'application/pdf', headers: { 'content-length': '204800' } },
    'https://example.com/pic.png': { html: 'xx', contentType: 'image/png' },
  });
  const base = startServer(t);
  let body = await (await fetch(`${base}/content-extract?url=${encodeURIComponent('https://example.com/notes.txt')}`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.text, /line one/);
  for (const target of ['https://example.com/paper.pdf', 'https://example.com/pic.png']) {
    const res = await fetch(`${base}/content-extract?url=${encodeURIComponent(target)}`);
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.status, 'invalid_input');
    assert.match(body.summary, /not a web page/);
  }
});

test('content-extract: an upstream error page is refused as unusable input, with the reason', async (t) => {
  stubPages(t, {
    'https://example.com/missing': { html: 'not found', status: 404 },
    'https://example.com/blocked': { html: 'forbidden', status: 403 },
  });
  const base = startServer(t);
  let body = await (await fetch(`${base}/content-extract?url=${encodeURIComponent('https://example.com/missing')}`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /does not exist \(HTTP 404\)/);
  body = await (await fetch(`${base}/content-extract?url=${encodeURIComponent('https://example.com/blocked')}`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /blocks automated readers/);
});

test('content-extract: a huge page is read only up to the cap', async (t) => {
  const target = 'https://example.com/huge';
  const filler = `<p>${'word '.repeat(200)}</p>\n`;
  stubPage(t, target, { html: `<title>Huge</title>${filler.repeat(5000)}` });
  const base = startServer(t);
  const res = await fetch(`${base}/content-extract?url=${encodeURIComponent(target)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.truncated, true);
  assert.ok(body.text.length <= 4_010);
});

test('content-extract: an unreachable host is an honest 200, not a 502', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/content-extract?url=${encodeURIComponent('https://this-domain-does-not-exist-zzz.invalid/')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /could not be (found|reached)/);
});

test('content-extract: a passage of text with no URL is extracted from the text itself', async (t) => {
  withoutLlm(t);
  const base = startServer(t);
  const passage = 'Extract the dates, quantities, named entities and events from: On 12 March 2024, Acme Corporation shipped 4,500 units to Berlin, a 12% rise on the prior year, according to CEO Jane Smith.';
  const res = await fetch(`${base}/content-extract?url=${encodeURIComponent(passage)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.extracted_from, 'supplied text');
  assert.match(body.summary, /2024/);
  assert.match(body.summary, /Acme Corporation/);
  assert.match(body.summary, /12%/);
  assert.ok(!/Extract the dates/.test(body.text), 'instruction preamble should be stripped from the passage');
});

test('content-extract: a short non-URL value still gets the URL guidance', async (t) => {
  const base = startServer(t);
  const body = await (await fetch(`${base}/content-extract?url=${encodeURIComponent('not a url at all')}`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /does not contain a valid http or https URL/);
});

test('content-extract: the LLM extraction of a passage is read as text, not as an object', async (t) => {
  const previous = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = 'test-key';
  t.after(() => { if (previous === undefined) delete process.env.PERPLEXITY_API_KEY; else process.env.PERPLEXITY_API_KEY = previous; });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'The passage is about graviton corrections. Dates: none. Quantities: none. Named entities: de Sitter.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const passage = 'Here is a passage (as text): "This work concerns a procedure for removing gauge dependence from graviton corrections to the effective field equations on de Sitter background."';
  const body = await (await fetch(`${base}/content-extract?url=${encodeURIComponent(passage)}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.provider, 'llm');
  assert.match(body.summary, /^The passage is about graviton corrections/);
  assert.ok(!/object Object/.test(body.summary));
});
