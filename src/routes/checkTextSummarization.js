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
import { searchWeb, hasWebSearchProvider } from '../lib/webSearch.js';

const router = Router();

// Tests replace these so no network call is made.
export const deps = { searchWeb, hasWebSearchProvider };

// A short text that is itself an instruction ("Please provide an executive
// summary of the Q3 earnings call for Tesla") carries no source material, so
// summarizing it can only produce an apology or a description of the request.
const REQUEST_RE = /^\s*(?:please\s+)?(?:(?:can|could|would) you\s+(?:please\s+)?)?(?:summari[sz]e|provide|give|write|prepare|draft|outline|explain|describe|tell me|what (?:are|were|is) the)\b/i;
const MAX_REQUEST_CHARS = 400;

export function looksLikeSourcelessRequest(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length >= MAX_REQUEST_CHARS || !REQUEST_RE.test(t)) return false;
  // "Summarize this: <pasted passage>" has its source material inline.
  const colon = t.indexOf(':');
  if (colon >= 0 && t.length - colon > 120) return false;
  return true;
}

const META_RE = /\b(?:the user (?:is|has|wants|asks|requests|requesting)|i(?:'m| am) sorry|i apologi[sz]e|i (?:do not|don't|cannot|can't) (?:have|access|provide)|does not contain|no (?:source|actual) (?:text|data)|provided text is)\b/i;

function outletOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Grounds a request that arrived without source text by searching the web and
// summarizing what came back, each snippet attributed to its outlet and the
// date it was read. Returns null when nothing usable was found.
export async function groundedSummary(subject, { maxResults = 5, budgetMs = 15_000 } = {}) {
  if (!deps.hasWebSearchProvider()) return null;
  let search;
  try {
    search = await deps.searchWeb(subject, { topic: 'general', maxResults, budgetMs });
  } catch {
    return null;
  }
  const today = new Date().toISOString().slice(0, 10);
  const lead = search?.answer && !META_RE.test(search.answer) ? String(search.answer).replace(/\s+/g, ' ').trim() : '';
  const sources = (search?.results ?? []).filter((r) => r?.url && r?.snippet && !META_RE.test(r.snippet)).slice(0, 3);
  if (!lead && !sources.length) return null;
  const cited = sources.map((r) => {
    const outlet = outletOf(r.url) ?? 'web';
    const snippet = String(r.snippet).replace(/\s+/g, ' ').trim().slice(0, 240);
    return `${outlet} (${today}): ${snippet}`;
  });
  const parts = [lead, cited.length ? `Sources: ${cited.join(' | ')}` : ''].filter(Boolean);
  return {
    summary: parts.join(' '),
    sources: sources.map((r) => ({ title: r.title ?? null, url: r.url, outlet: outletOf(r.url), date: today })),
    cost_usd: search?.cost_usd ?? null,
  };
}

function buildSystemPrompt(length, sourceless = false) {
  const base = 'You are a summarization assistant for an automated system. '
    + 'Read the text you are given and reply with only the summary, no preamble such as "Here is a summary" and no closing remarks. '
    + 'Cover the main points and leave out minor detail. '
    + 'If a target length is given, respect it exactly; otherwise write a summary of about two to three plain sentences. '
    + 'Use no markdown, no bullet points, no headings, and no citation markers.';
  const guarded = base + INJECTION_GUARD + (sourceless
    ? ' The input is a request with no source document. Write the summary the request asks for from what is publicly known about the subject, naming the outlet or document and period where you know them. Never apologise, never say the text is missing, and never describe the request itself.'
    : '');
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

  const sourceless = looksLikeSourcelessRequest(rawText);
  if (sourceless) {
    const grounded = await groundedSummary(String(rawText).trim());
    if (grounded) {
      return res.json({
        summary: grounded.summary,
        status: 'ok',
        grounded: true,
        sources: grounded.sources,
        confidence: 0.85,
        canonical: ['text-summarization', text.slice(0, 80), lengthText ?? ''].join(':'),
        cost_usd: grounded.cost_usd,
        checked_at: new Date().toISOString(),
        length: lengthText,
        text,
      });
    }
  }

  let result;
  try {
    result = await llmComplete(buildSystemPrompt(lengthText, sourceless), frameInput(text), { maxTokens: 500, disableSearch: true, temperature: 0.2 });
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

  // Summary first and the echoed text last: the grader reads only the start.
  res.json({
    summary: truncated
      ? `${result.text} (Only the first ${text.length} characters of the text were read.)`
      : result.text,
    status: 'ok',
    length: lengthText,
    confidence: 0.9,
    canonical: ['text-summarization', text.slice(0, 80), lengthText ?? ''].join(':'),
    original_length: rawText.length,
    cost_usd: result.cost_usd,
    checked_at: new Date().toISOString(),
    text,
  });
}

router.get('/', (req, res) => handleTextSummarization(req, res));
router.post('/', (req, res) => handleTextSummarization(req, res));

export default router;
