// Shape tests for the judgment-scored intents that were reworked on 2026-11-12:
// KYC liveness, LLM output evaluation, grounded summarization, grounded text
// generation and the grammar issue list. Every network call is stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import { kycLivenessRouter } from './newIntents.js';
import { llmOutputEvaluationRouter, splitStrengthsErrors } from './llmIntents.js';
import summarizeRouter, { deps, looksLikeSourcelessRequest } from './checkTextSummarization.js';
import generateRouter, { looksLikePaperRequest } from './checkTextGeneration.js';
import grammarRouter, { parseIssue } from './checkGrammarSpellCheck.js';

process.env.LANGUAGETOOL_URL = 'http://127.0.0.1:1/check';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && !Array.isArray(body) && body.answer === undefined && typeof body.summary === 'string' && body.summary.trim()) {
        return sendJson({ ...body, answer: body.summary });
      }
      return sendJson(body);
    };
    next();
  });
  app.use('/kyc', forwardAsyncErrors(kycLivenessRouter));
  app.use('/eval', forwardAsyncErrors(llmOutputEvaluationRouter));
  app.use('/summarize', forwardAsyncErrors(summarizeRouter));
  app.use('/generate', forwardAsyncErrors(generateRouter));
  app.use('/grammar', forwardAsyncErrors(grammarRouter));
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function withKey(t) {
  const previous = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = 'pplx-test-key';
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
    calls.push({ body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function stubSearch(t, result) {
  const original = { ...deps };
  const calls = [];
  deps.hasWebSearchProvider = () => true;
  deps.searchWeb = async (query, options) => {
    calls.push({ query, options });
    return result;
  };
  t.after(() => { Object.assign(deps, original); });
  return calls;
}

test('kyc-liveness: body carries the structured not-performed checks and a verdict', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Inconclusive. No image or video was inspected. A liveness check needs a live challenge-response capture, and a selfie-to-ID match needs the document image.');
  const base = startServer(t);
  const q = "I've uploaded a photo of myself and my driver's license. Can you confirm this is a live person?";
  const body = await (await fetch(`${base}/kyc?query=${encodeURIComponent(q)}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'Inconclusive');
  assert.equal(body.found, false);
  assert.equal(body.liveness_checked, false);
  assert.equal(body.document_match_checked, false);
  assert.deepEqual(body.checks_performed, []);
  assert.equal(body.checks_not_performed.length, 3);
  assert.match(body.checks_not_performed[0], /challenge-response/);
});

test('kyc-liveness: the prompt asks the sentence to name what a passing check needs', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Inconclusive. Nothing was inspected.');
  const base = startServer(t);
  await fetch(`${base}/kyc?query=check+my+selfie`);
  assert.match(calls[0].body.instructions, /live challenge-response capture/);
  assert.match(calls[0].body.instructions, /identity document image/);
});

test('llm-output-evaluation: with no output the prompt judges the scenario and never defaults to Fails', async (t) => {
  withKey(t);
  const calls = stubPerplexity(t, 'Acceptable. Supported: no, the facts given do not show the attachment was verified. Follows instructions: yes, it addresses the case. Safe to accept: no, the privacy-sensitive attachment must be redacted first. Score: 5/10. Strengths: names the privacy risk; keeps to the case. Errors: no verification step; no redaction step.');
  const base = startServer(t);
  const q = 'For a legal intake team, case 4 concerns a privacy-sensitive attachment. Judge whether the answer is supported, follows instructions, and is safe to accept.';
  const body = await (await fetch(`${base}/eval?prompt=${encodeURIComponent(q)}`)).json();
  assert.equal(body.status, 'ok');
  assert.notEqual(body.verdict, 'Fails');
  assert.match(body.summary, /supported/i);
  assert.match(calls[0].body.instructions, /treat the scenario in the prompt itself as the answer under review/);
  assert.deepEqual(body.strengths, ['names the privacy risk', 'keeps to the case']);
  assert.deepEqual(body.errors, ['no verification step', 'no redaction step']);
});

test('llm-output-evaluation: strengths and errors split tolerates missing markers and "none found"', () => {
  assert.deepEqual(splitStrengthsErrors('Good. Score: 8/10.'), { strengths: [], errors: [] });
  assert.deepEqual(splitStrengthsErrors('Good. Strengths: clear. Errors: none found'), { strengths: ['clear'], errors: [] });
});

test('summarization: request detection', () => {
  assert.equal(looksLikeSourcelessRequest('Please provide an executive summary of the Q3 2023 earnings call transcript for Tesla'), true);
  assert.equal(looksLikeSourcelessRequest('some text'), false);
  assert.equal(looksLikeSourcelessRequest(`Summarize this: ${'Revenue grew and margins held steady across regions. '.repeat(6)}`), false);
});

test('summarization: a request with no source text is grounded with search, summary first, text last', async (t) => {
  withKey(t);
  const llmCalls = stubPerplexity(t, 'should not be called');
  const searchCalls = stubSearch(t, {
    answer: 'Tesla reported Q3 2023 revenue of $23.4 billion, up 9 percent year on year, with a 17.6 percent gross margin.',
    results: [
      { title: 'Tesla Q3 results', url: 'https://www.reuters.com/business/tesla-q3', snippet: 'Revenue of $23.35 billion missed estimates as price cuts squeezed margins.', score: null },
    ],
    cost_usd: 0.01,
  });
  const base = startServer(t);
  const text = 'Please provide an executive summary of the Q3 2023 earnings call transcript for Tesla';
  const res = await fetch(`${base}/summarize?text=${encodeURIComponent(text)}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(searchCalls.length, 1);
  assert.equal(llmCalls.length, 0);
  assert.equal(body.grounded, true);
  assert.match(body.summary, /\$23\.4 billion/);
  assert.match(body.summary, /reuters\.com \(\d{4}-\d{2}-\d{2}\)/);
  assert.doesNotMatch(body.summary, /requesting|sorry/i);
  const keys = Object.keys(body).filter((k) => k !== 'answer'); // answer is added by the app-level middleware, ordered by src/app.js
  assert.equal(keys[0], 'summary');
  assert.equal(keys[keys.length - 1], 'text');
});

test('summarization: a search that returns an apology is not passed on', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Tesla reported record deliveries in the third quarter of 2023.');
  stubSearch(t, { answer: "I'm sorry, but I don't have access to that information.", results: [] });
  const base = startServer(t);
  const body = await (await fetch(`${base}/summarize?text=${encodeURIComponent('Please summarize the Tesla Q3 2023 earnings call')}`)).json();
  assert.equal(body.status, 'ok');
  assert.doesNotMatch(body.summary, /sorry/i);
  assert.notEqual(body.grounded, true);
});

test('summarization: ordinary text puts summary first and the echoed text last', async (t) => {
  withKey(t);
  stubPerplexity(t, 'A short summary.');
  const base = startServer(t);
  const body = await (await fetch(`${base}/summarize?text=${encodeURIComponent('Quarterly revenue rose twelve percent on strong demand.')}`)).json();
  const keys = Object.keys(body).filter((k) => k !== 'answer'); // answer is added by the app-level middleware, ordered by src/app.js
  assert.equal(keys[0], 'summary');
  assert.equal(keys[keys.length - 1], 'text');
});

test('text-generation: "summarize the key findings of the paper" is grounded, summary first, prompt last', async (t) => {
  withKey(t);
  const llmCalls = stubPerplexity(t, 'should not be called');
  const searchCalls = stubSearch(t, {
    answer: 'The paper Attention Is All You Need introduces the Transformer, which reached 28.4 BLEU on English to German translation.',
    results: [{ title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', snippet: 'The Transformer relies entirely on attention and trains faster than recurrent models.', score: null }],
    cost_usd: 0,
  });
  assert.equal(looksLikePaperRequest('Summarize the key findings of the research paper titled "Attention Is All You Need".'), true);
  assert.equal(looksLikePaperRequest('Write a short professional email to a client.'), false);
  const base = startServer(t);
  const prompt = 'Summarize the key findings of the research paper titled "Attention Is All You Need".';
  const body = await (await fetch(`${base}/generate?prompt=${encodeURIComponent(prompt)}`)).json();
  assert.equal(searchCalls.length, 1);
  assert.equal(llmCalls.length, 0);
  assert.match(body.summary, /Transformer/);
  assert.match(body.summary, /arxiv\.org/);
  const keys = Object.keys(body).filter((k) => k !== 'answer'); // answer is added by the app-level middleware, ordered by src/app.js
  assert.equal(keys[0], 'summary');
  assert.equal(keys[keys.length - 1], 'prompt');
});

test('text-generation: an ordinary writing prompt is not searched and keeps prompt last', async (t) => {
  withKey(t);
  stubPerplexity(t, 'Dear client, thank you for your time.');
  const searchCalls = stubSearch(t, { answer: 'x', results: [] });
  const base = startServer(t);
  const body = await (await fetch(`${base}/generate?prompt=${encodeURIComponent('Write a short professional email thanking a client.')}`)).json();
  assert.equal(searchCalls.length, 0);
  assert.equal(body.summary, 'Dear client, thank you for your time.');
  const keys = Object.keys(body).filter((k) => k !== 'answer'); // answer is added by the app-level middleware, ordered by src/app.js
  assert.equal(keys[keys.length - 1], 'prompt');
});

test('grammar: summary lists each issue with its explanation, then the corrected text', async (t) => {
  withKey(t);
  stubPerplexity(t, "They're going to the park and it's raining.\nChanges: 2: Their -> They're (wrong homophone); its -> it's (missing apostrophe)");
  const base = startServer(t);
  const body = await (await fetch(`${base}/grammar?text=${encodeURIComponent('Their going to the park and its raining.')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.issues.length, 2);
  assert.equal(body.error_count, 2);
  assert.deepEqual(body.issues[0], { error: 'Their', suggestion: "They're", message: 'wrong homophone', type: 'grammar' });
  assert.equal(body.issues[1].error, 'its');
  assert.equal(body.issues[1].type, 'punctuation');
  assert.equal(body.summary, "2 issues found: 'Their' should be 'They're' (wrong homophone), 'its' should be 'it's' (missing apostrophe). Corrected text: They're going to the park and it's raining.");
  const keys = Object.keys(body).filter((k) => k !== 'answer'); // answer is added by the app-level middleware, ordered by src/app.js
  assert.equal(keys[0], 'summary');
  assert.equal(keys[keys.length - 1], 'text');
});

test('grammar: parseIssue handles a fix with no arrow', () => {
  const issue = parseIssue('added a missing comma');
  assert.equal(issue.error, null);
  assert.equal(issue.message, 'added a missing comma');
  assert.equal(issue.type, 'punctuation');
});
