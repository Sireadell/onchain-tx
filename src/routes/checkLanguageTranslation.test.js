import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { parseInstruction } from './checkLanguageTranslation.js';

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

test('language-translate: missing text answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/language-translate?target=Spanish`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('language-translate: missing target answered with guidance, not a 400', async (t) => {
  withKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/language-translate?text=hello`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('language-translate: translates text into the target language', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Hola');
  const base = startServer(t);
  const res = await fetch(`${base}/language-translate?text=hello&target=Spanish`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.summary, 'Hola');
  assert.equal(body.target, 'Spanish');
  assert.match(calls[0].body.instructions, /Spanish/);
  // The caller's text travels inside the data markers the guard names, and
  // the search is off: a translation has nothing to look up.
  assert.equal(calls[0].body.input[0].content, '<<<TEXT>>>\nhello\n<<<END>>>');
  assert.equal(calls[0].body.tools, undefined);
});

test('language-translate: reads the target language out of the whole instruction', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Hallo');
  const base = startServer(t);
  const res = await fetch(`${base}/language-translate?text=${encodeURIComponent('Translate "hello" into German.')}`);
  const body = await res.json();

  assert.equal(body.status, 'ok');
  assert.equal(body.target, 'German');
  assert.equal(body.text, 'hello');
  assert.equal(body.summary, 'Hallo');
  assert.match(calls[0].body.instructions, /into German/);
  assert.equal(calls[0].body.input[0].content, '<<<TEXT>>>\nhello\n<<<END>>>');
});

test('language-translate: the router shapes seen in real traffic all yield a target', () => {
  const cases = [
    ['Translate the following text into Hindi (hi): "The Supreme Court ruled."', 'Hindi', 'The Supreme Court ruled.'],
    ['What\'s the translation of "no translation is stated." into Polish?', 'Polish', 'no translation is stated.'],
    ['Translate meow into german', 'German', 'meow'],
    ['translate into hindi "Wow awesome"', 'Hindi', 'Wow awesome'],
    ['Japanese translation -  "No wallet, no key"', 'Japanese', 'No wallet, no key'],
    ['Hi, translate in finnish\n\nI was in the shop, where were you?', 'Finnish', 'I was in the shop, where were you?'],
    ['Say hello in Spanish.', 'Spanish', 'hello'],
    ["Translate 'good morning, how are you' in urdu", 'Urdu', 'good morning, how are you'],
    ['Translate this into French "Reasoning\nBalance could not be read."', 'French', 'Reasoning\nBalance could not be read.'],
  ];
  for (const [question, target, text] of cases) {
    assert.deepEqual(parseInstruction(question), { text, target }, question);
  }
  assert.deepEqual(parseInstruction('hello'), { text: null, target: null });
});

test('language-translate: competitor param names and ISO codes are accepted', async (t) => {
  withKey(t);
  stubPerplexity(t, 'bonjour');
  const base = startServer(t);
  for (const qs of ['q=hello&target_language=French', 'text=hello&to=fr', 'text=hello&langpair=en|fr', 'text=hello&language=French']) {
    const body = await (await fetch(`${base}/language-translate?${qs}`)).json();
    assert.equal(body.status, 'ok', qs);
    assert.equal(body.target, 'French', qs);
  }
});

test('language-translate: an explicit target beats the one named in the text', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Hola');
  const base = startServer(t);
  const body = await (await fetch(`${base}/language-translate?text=${encodeURIComponent('Translate "hello" into German.')}&target=Spanish`)).json();
  assert.equal(body.target, 'Spanish');
  assert.match(calls[0].body.instructions, /into Spanish/);
});

test('language-translate: a quoted reply is unquoted and a huge text is capped', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, '"Bonjour"');
  const base = startServer(t);
  const res = await fetch(`${base}/language-translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(20000), target: 'French' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.translation, 'Bonjour');
  assert.match(body.summary, /^Bonjour \(The text was longer than 12000 characters/);
  assert.ok(calls[0].body.input[0].content.length < 12100);
});

test('language-translate: a provider failure is a real 502', async (t) => {
  withKey(t);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.perplexity.ai')) return original(url, init);
    return new Response('{}', { status: 401 });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const res = await fetch(`${base}/language-translate?text=hello&target=French`);
  assert.equal(res.status, 502);
});
