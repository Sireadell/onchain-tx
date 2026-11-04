import test from 'node:test';
import assert from 'node:assert/strict';
import { groqComplete, geminiComplete } from './llmProviders.js';

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
