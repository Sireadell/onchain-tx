import test from 'node:test';
import assert from 'node:assert/strict';
import { llmComplete } from './llmComplete.js';

function stubFetch(t, replies) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const who = String(url).includes('groq') ? 'groq' : 'gemini';
    const text = replies[who];
    return new Response(JSON.stringify({
      choices: [{ message: { content: text } }],
      candidates: [{ content: { parts: [{ text }] } }],
    }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
}

test('a short refusal from the first free model moves on to the next one', async (t) => {
  delete process.env.PERPLEXITY_API_KEY;
  process.env.GROQ_API_KEY = 'k';
  process.env.GEMINI_API_KEY = 'k';
  stubFetch(t, { groq: 'I’m sorry, but I can’t answer that.', gemini: 'Paris is the capital of France.' });
  const out = await llmComplete('s', 'unique refusal question one', { rejectRefusal: true });
  assert.equal(out.text, 'Paris is the capital of France.');
  assert.equal(out.provider, 'gemini');
});

test('without the refusal check the first answer is returned as is', async (t) => {
  delete process.env.PERPLEXITY_API_KEY;
  process.env.GROQ_API_KEY = 'k';
  process.env.GEMINI_API_KEY = 'k';
  stubFetch(t, { groq: 'I cannot help with that.', gemini: 'Something else.' });
  const out = await llmComplete('s', 'unique refusal question two');
  assert.equal(out.provider, 'groq');
});
