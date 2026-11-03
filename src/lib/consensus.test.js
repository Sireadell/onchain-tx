import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { agrees, findConsensus, consensusSearch, consensusConfigured } from './consensus.js';
import { llmComplete } from './llmComplete.js';
import { resetSpendGuard } from './spendGuard.js';

beforeEach(() => {
  resetSpendGuard();
  delete process.env.PERPLEXITY_API_KEY;
  process.env.TAVILY_API_KEY = 't';
  process.env.GROQ_API_KEY = 'g';
  process.env.GEMINI_API_KEY = 'm';
});

const vote = (name, short, full) => ({ name, short, full: full ?? short });

test('answers that share the key facts agree, different facts do not', () => {
  assert.ok(agrees(vote('a', '1958', 'Things Fall Apart was published in 1958.'), vote('b', 'Published in 1958', 'It came out in 1958.')));
  assert.ok(!agrees(vote('a', 'Canberra', 'The capital is Canberra.'), vote('b', 'Sydney', 'The capital is Sydney.')));
  assert.ok(agrees(vote('a', '1,200 meters', 'It is 1,200 meters tall.'), vote('b', '1200 meters', 'About 1200 meters.')));
});

test('two of three agreeing is a consensus, three different answers is not', () => {
  const two = findConsensus([vote('a', 'Canberra'), vote('b', 'Canberra, Australia'), vote('c', 'Sydney')]);
  assert.equal(two.length, 2);
  assert.equal(findConsensus([vote('a', 'Canberra'), vote('b', 'Sydney'), vote('c', 'Melbourne')]), null);
});

// Stubs Groq and Gemini; each reply is { short, full } JSON or an HTTP error.
function stubModels(t, { groq, gemini }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const reply = u.includes('groq.com') ? groq : u.includes('googleapis.com') ? gemini : null;
    if (!reply) return original(url);
    if (reply.status) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: reply.status });
    const text = JSON.stringify(reply);
    return new Response(JSON.stringify(u.includes('groq.com')
      ? { choices: [{ message: { content: text } }] }
      : { candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
}

const tavily = (answer) => async () => ({ answer, results: [{ title: 'Page', url: 'https://x.test', snippet: 'evidence' }], provider: 'tavily' });
const run = (answer, q = 'capital of australia') => consensusSearch(q, { topic: 'general', maxResults: 5, budgetMs: 15_000, tavily: tavily(answer) });

test('all three voters agreeing gives consensus 3 of 3', async (t) => {
  stubModels(t, { groq: { short: 'Canberra', full: 'The capital of Australia is Canberra.' }, gemini: { short: 'Canberra', full: 'Canberra is the capital.' } });
  const out = await run('Canberra is the capital city of Australia.', 'q1');
  assert.equal(out.status, 'consensus');
  assert.equal(out.agree, 3);
  assert.match(out.answer, /Canberra/);
});

test('one voter out of line is outvoted', async (t) => {
  stubModels(t, { groq: { short: 'Canberra', full: 'The capital is Canberra.' }, gemini: { short: 'Sydney', full: 'The capital is Sydney.' } });
  const out = await run('Canberra is the capital city of Australia.', 'q2');
  assert.equal(out.status, 'consensus');
  assert.equal(out.agree, 2);
  assert.ok(!out.voters.includes('gemini'));
});

test('three different answers are inconclusive, never a guess', async (t) => {
  stubModels(t, { groq: { short: 'Sydney', full: 'It is Sydney.' }, gemini: { short: 'Melbourne', full: 'It is Melbourne.' } });
  const out = await run('Canberra is the capital city of Australia.', 'q3');
  assert.equal(out.status, 'inconclusive');
});

test('fewer than two voters means consensus is unavailable', async (t) => {
  stubModels(t, { groq: { status: 500 }, gemini: { status: 500 } });
  const out = await run('Canberra is the capital.', 'q4');
  assert.equal(out.status, 'unavailable');
});

test('a refused model is skipped and the other two still decide', async (t) => {
  stubModels(t, { groq: { short: 'Canberra', full: 'Canberra.' }, gemini: { status: 429 } });
  const out = await run('Canberra is the capital city of Australia.', 'q5');
  assert.equal(out.status, 'consensus');
  assert.equal(out.total, 2);
});

test('consensus needs Tavily plus one model key', () => {
  assert.ok(consensusConfigured());
  delete process.env.GROQ_API_KEY; delete process.env.GEMINI_API_KEY;
  assert.ok(!consensusConfigured());
});

test('a Groq rate limit is retried once before moving on', async (t) => {
  delete process.env.GEMINI_API_KEY;
  process.env.LLM_RATE_LIMIT_WAIT_MS = '10';
  const original = globalThis.fetch;
  let groqCalls = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).includes('groq.com')) return original(url);
    groqCalls += 1;
    return groqCalls === 1
      ? new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'Salut' } }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; delete process.env.LLM_RATE_LIMIT_WAIT_MS; });
  const out = await llmComplete('Translate to French.', 'hi retry', { disableSearch: true });
  assert.equal(out.text, 'Salut');
  assert.equal(groqCalls, 2);
});

test('text intents fall back to Groq when there is no Perplexity key', async (t) => {
  delete process.env.GEMINI_API_KEY;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('groq.com')
    ? new Response(JSON.stringify({ choices: [{ message: { content: '**Bonjour** le monde' } }] }), { status: 200 })
    : original(url));
  t.after(() => { globalThis.fetch = original; });
  const out = await llmComplete('Translate to French.', 'hello world', { disableSearch: true });
  assert.equal(out.text, 'Bonjour le monde');
  assert.equal(out.cost_usd, 0);
});
