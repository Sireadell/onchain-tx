import test from 'node:test';
import assert from 'node:assert/strict';
import { groqComplete, geminiComplete, retryAfterMs, resetProviderState } from './llmProviders.js';

function stubFetch(t, answers) {
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const model = JSON.parse(init.body).model ?? decodeURIComponent(String(url).match(/models\/([^:]+):/)[1]);
    asked.push(model);
    const status = answers[model] ?? 200;
    const body = status === 200
      ? { choices: [{ message: { content: `from ${model}` } }], candidates: [{ content: { parts: [{ text: `from ${model}` }] } }] }
      : { error: { message: 'quota used up' } };
    return new Response(JSON.stringify(body), { status });
  };
  t.after(() => { globalThis.fetch = original; });
  return asked;
}

test('groq: a model out of daily allowance hands over to the next model', async (t) => {
  process.env.GROQ_API_KEY = 'k';
  delete process.env.GROQ_MODEL;
  const asked = stubFetch(t, { 'openai/gpt-oss-120b': 429 });
  const out = await groqComplete('s', 'u');
  assert.equal(out.text, 'from openai/gpt-oss-20b');
  assert.deepEqual(asked, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
});

test('gemini: moves past a missing model and a rejected request', async (t) => {
  process.env.GEMINI_API_KEY = 'k';
  delete process.env.GEMINI_MODEL;
  const asked = stubFetch(t, { 'gemini-3-flash-preview': 429, 'gemini-3.1-flash-lite': 404, 'gemini-3.5-flash-lite': 400 });
  const out = await geminiComplete('s', 'u');
  assert.equal(out.text, 'from gemma-4-31b-it');
  assert.equal(asked.length, 4);
});

test('groq: every model out of allowance reports each reason', async (t) => {
  process.env.GROQ_API_KEY = 'k';
  stubFetch(t, { 'openai/gpt-oss-120b': 429, 'openai/gpt-oss-20b': 429, 'qwen/qwen3.8-27b': 429 });
  await assert.rejects(() => groqComplete('s', 'u'), (err) => err.status === 429 && /gpt-oss-120b.*gpt-oss-20b.*qwen/.test(err.message));
});

test('a bad key is not retried on other models', async (t) => {
  process.env.GROQ_API_KEY = 'k';
  const asked = stubFetch(t, { 'openai/gpt-oss-120b': 401 });
  await assert.rejects(() => groqComplete('s', 'u'), (err) => err.status === 401);
  assert.equal(asked.length, 1);
});

test('groq: the second key is tried on the same model before a smaller model', async (t) => {
  process.env.GROQ_API_KEY = 'k1';
  process.env.GROQ_API_KEY_2 = 'k2';
  t.after(() => { delete process.env.GROQ_API_KEY_2; });
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const { model } = JSON.parse(init.body);
    const key = init.headers.Authorization.slice(7);
    asked.push(`${model} ${key}`);
    const ok = key === 'k2';
    return new Response(JSON.stringify(ok ? { choices: [{ message: { content: `from ${model} ${key}` } }] } : { error: { message: 'quota used up' } }), { status: ok ? 200 : 429 });
  };
  t.after(() => { globalThis.fetch = original; });
  const out = await groqComplete('s', 'u');
  assert.equal(out.text, 'from openai/gpt-oss-120b k2');
  assert.deepEqual(asked, ['openai/gpt-oss-120b k1', 'openai/gpt-oss-120b k2']);
});

test('groq: a third key is tried after the first two on the same model', async (t) => {
  process.env.GROQ_API_KEY = 'k1';
  process.env.GROQ_API_KEY_2 = 'k2';
  process.env.GROQ_API_KEY_3 = 'k3';
  t.after(() => { delete process.env.GROQ_API_KEY_2; delete process.env.GROQ_API_KEY_3; });
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const { model } = JSON.parse(init.body);
    const key = init.headers.Authorization.slice(7);
    asked.push(`${model} ${key}`);
    const ok = key === 'k3';
    return new Response(JSON.stringify(ok ? { choices: [{ message: { content: 'ok' } }] } : { error: { message: 'quota used up' } }), { status: ok ? 200 : 429 });
  };
  t.after(() => { globalThis.fetch = original; });
  await groqComplete('s', 'u');
  assert.deepEqual(asked, ['openai/gpt-oss-120b k1', 'openai/gpt-oss-120b k2', 'openai/gpt-oss-120b k3']);
});

test('retryAfterMs reads the wait a per-minute limit asks for', () => {
  assert.equal(retryAfterMs('Rate limit reached on tokens per minute (TPM): Limit 8000. Please try again in 5.9s. Need more tokens?'), 5900);
  assert.equal(retryAfterMs('Please try again in 450ms.'), 450);
  assert.equal(retryAfterMs('Please try again in 1m2.5s.'), 62500);
  assert.equal(retryAfterMs('quota used up'), null);
});

test('groq: when every key is on a short per-minute pause, waits it out instead of giving up', async (t) => {
  process.env.LLM_GUARD_FORCE = '1';
  process.env.GROQ_API_KEY = 'k1';
  process.env.GROQ_MODEL = 'only-model';
  resetProviderState();
  t.after(() => { delete process.env.LLM_GUARD_FORCE; delete process.env.GROQ_MODEL; resetProviderState(); });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    const { model } = JSON.parse(init.body);
    const busy = calls <= 3;
    return new Response(JSON.stringify(busy
      ? { error: { message: `Rate limit reached for model ${model} on tokens per minute (TPM): Limit 8000. Please try again in 300ms.` } }
      : { choices: [{ message: { content: `from ${model}` } }] }), { status: busy ? 429 : 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  const out = await groqComplete('s', 'u', { budgetMs: 8_000 });
  assert.match(out.text, /^from /);
  assert.equal(calls, 4);
});

test('groq: the next question goes to the key with the most room this minute', async (t) => {
  process.env.LLM_GUARD_FORCE = '1';
  process.env.GROQ_API_KEY = 'k1';
  process.env.GROQ_API_KEY_2 = 'k2';
  delete process.env.GROQ_MODEL;
  resetProviderState();
  t.after(() => { delete process.env.LLM_GUARD_FORCE; delete process.env.GROQ_API_KEY_2; resetProviderState(); });
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const key = init.headers.Authorization.slice(7);
    asked.push(key);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'x-ratelimit-remaining-tokens': key === 'k1' ? '300' : '7000', 'x-ratelimit-reset-tokens': '30s' },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  await groqComplete('s', 'u'); // k1 first: nothing is known yet
  await groqComplete('s', 'u'); // nothing known about k2 yet, so k2 (unknown = full) beats k1 (300 left)
  await groqComplete('s', 'u'); // k2 has 7000, k1 too full for the reply allowance
  assert.deepEqual(asked, ['k1', 'k2', 'k2']);
});
