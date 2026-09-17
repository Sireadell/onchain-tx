// TEXT_SUMMARIZATION signal endpoint. Summarizes supplied text to a
// length/style if given, otherwise a sensible default. Params: text
// (required, also accepted as content/input/question/query/q/message/
// document/article). Optional: length (a word count, a sentence count, or
// a word like "short"/"one paragraph", also accepted as max_words/words/
// sentences/summary_length/style).

import { Router } from 'express';
import {
  llmComplete, hasLlmProvider, LlmCompleteError, capInput, INJECTION_GUARD, frameInput,
} from '../lib/llmComplete.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

function buildSystemPrompt(length) {
  const base = 'You are a summarization assistant for an automated system. '
    + 'Read the text you are given and reply with only the summary, no preamble such as "Here is a summary" and no closing remarks. '
    + 'Cover the main points and leave out minor detail. '
    + 'If a target length is given, respect it exactly; otherwise write a summary of about two to three plain sentences. '
    + 'Use no markdown, no bullet points, no headings, and no citation markers.';
  const guarded = base + INJECTION_GUARD;
  if (!length) return guarded;
  return `${guarded} Target length: ${length}.`;
}

async function handleTextSummarization(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawText = firstUsableValue(
    params?.text, params?.content, params?.input, params?.question, params?.query,
    params?.q, params?.message, params?.document, params?.article, params?.prompt,
  );
  const length = firstUsableValue(
    params?.length, params?.max_words, params?.words, params?.sentences,
    params?.summary_length, params?.style,
  );

  if (!rawText || !String(rawText).trim()) {
    return respondUnusableInput(
      res,
      'I cannot summarize anything because no text was supplied. Pass the text as the text parameter and I will return a summary. Optionally pass a length as the length parameter, for example "50 words" or "one sentence".',
    );
  }

  if (!hasLlmProvider()) {
    return res.status(503).json({
      status: 'error',
      summary: 'Text summarization is not configured on this deployment.',
      confidence: 0,
      error: 'PERPLEXITY_API_KEY is not set',
    });
  }

  const { text, truncated } = capInput(rawText);
  const lengthText = length ? String(length).slice(0, 60) : null;

  let result;
  try {
    result = await llmComplete(buildSystemPrompt(lengthText), frameInput(text), { maxTokens: 500, disableSearch: true, temperature: 0.2 });
  } catch (err) {
    if (err instanceof LlmCompleteError) {
      return res.status(502).json({
        status: 'error',
        summary: `Text summarization is temporarily unavailable for ${quoteParam(rawText)}. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    return res.status(502).json({ status: 'error', summary: 'text summarization failed', confidence: 0, error: err.message });
  }

  if (!result) {
    return respondUnusableInput(res, `No summary could be produced for ${quoteParam(rawText)}. Try rephrasing or shortening the text.`);
  }

  res.json({
    text,
    length: lengthText,
    status: 'ok',
    summary: truncated
      ? `${result.text} (Only the first ${text.length} characters of the text were read.)`
      : result.text,
    confidence: 0.9,
    canonical: ['text-summarization', text.slice(0, 80), lengthText ?? ''].join(':'),
    original_length: rawText.length,
    cost_usd: result.cost_usd,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleTextSummarization(req, res));
router.post('/', (req, res) => handleTextSummarization(req, res));

export default router;
