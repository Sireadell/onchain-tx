// SENTIMENT_ANALYSIS signal endpoint. Given text, return its sentiment as
// exactly one of Positive/Negative/Neutral/Mixed with a short reason, via
// lib/llmComplete.js (Perplexity). Params: text (required, also accepted
// as content/review/message/comment/input/question/query/q/sentence).
//
// Real traffic here (70 routed questions in 11 days) is almost entirely
// "What is the general sentiment (positive, negative, or neutral) toward
// token/contract X?", which asks about a subject in the world rather than
// about supplied text, plus a few "Analyze the sentiment of the following
// text about Y: ...". The miner that took most of those answered "The
// general sentiment toward X is negative. <why>". So: a bare question about
// a subject keeps the model's web search on (it has to know something
// about X), while supplied text is judged with search off.

import { Router } from 'express';
import { llmComplete, hasLlmProvider, LlmCompleteError, capInput, INJECTION_GUARD, frameInput } from '../lib/llmComplete.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const SYSTEM_PROMPT = 'You are a sentiment analysis assistant for an automated system. '
  + 'Classify the sentiment of the user\'s text as exactly one of: Positive, Negative, Neutral, or Mixed. '
  + 'If the text is instead a question asking about the general sentiment toward some subject (a company, token, product, event), '
  + 'answer with the sentiment toward that subject based on what is currently known, committing to your single best call. '
  + 'Respond in the form "<Label>. <one or two short sentences explaining why>." The label must be the first word. '
  + 'Use no markdown, no bullet points, no citation markers, and state only the label and the explanation.'
  + INJECTION_GUARD;

const LABELS = ['Positive', 'Negative', 'Neutral', 'Mixed'];
const LEAD_RE = /^(Positive|Negative|Neutral|Mixed)\b/i;
const ANY_RE = /\b(positive|negative|neutral|mixed)\b/i;

// A question about a subject, with no text of its own to judge. "What is
// the general sentiment toward X?" is one; "Is this review positive: ..."
// is not, because it carries the review after the colon.
function asksAboutSubject(text) {
  const t = String(text);
  if (/[:"“]/.test(t)) return false;
  return /\bsentiment\b[^?]*\b(?:toward|towards|about|on|for|around|regarding)\b/i.test(t) && /\?\s*$/.test(t);
}

// Reads the label the reply leads with, or failing that the first label
// word anywhere in it, and makes sure the graded text leads with it.
export function normaliseReply(text) {
  const reply = String(text ?? '').trim();
  const lead = reply.match(LEAD_RE);
  if (lead) {
    const label = LABELS.find((l) => l.toLowerCase() === lead[1].toLowerCase());
    return { label, summary: reply };
  }
  const any = reply.match(ANY_RE);
  if (!any) return { label: null, summary: reply };
  const label = LABELS.find((l) => l.toLowerCase() === any[1].toLowerCase());
  return { label, summary: `${label}. ${reply}` };
}

async function handleSentimentAnalysis(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawText = firstUsableValue(
    params?.text, params?.content, params?.review, params?.message, params?.comment, params?.input,
    params?.question, params?.query, params?.q, params?.sentence, params?.prompt,
  );

  if (!rawText || !String(rawText).trim()) {
    return respondUnusableInput(
      res,
      'I cannot analyze sentiment because no text was supplied. Pass the text as the text parameter and I will return its sentiment with a brief reason.',
    );
  }

  if (!hasLlmProvider()) {
    return res.status(503).json({
      status: 'error',
      summary: 'Sentiment analysis is not configured on this deployment.',
      confidence: 0,
      error: 'PERPLEXITY_API_KEY is not set',
    });
  }

  const { text, truncated } = capInput(rawText);
  const disableSearch = !asksAboutSubject(text);

  let result;
  try {
    result = await llmComplete(SYSTEM_PROMPT, frameInput(text), { maxTokens: 200, disableSearch, temperature: 0 });
  } catch (err) {
    if (err instanceof LlmCompleteError) {
      return res.status(502).json({ status: 'error', summary: 'sentiment analysis service failed', confidence: 0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'sentiment analysis failed', confidence: 0, error: err.message });
  }

  if (!result) {
    return respondUnusableInput(res, 'The sentiment analysis service returned nothing usable for this text. Try rephrasing it.');
  }

  const { label, summary } = normaliseReply(result.text);

  res.json({
    text,
    status: 'ok',
    summary: truncated ? `${summary} (Only the first ${text.length} characters of the text were read.)` : summary,
    sentiment: label,
    confidence: label ? 0.9 : 0.6,
    canonical: ['sentiment-analysis', text.slice(0, 80)].join(':'),
    cost_usd: result.cost_usd,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleSentimentAnalysis(req, res));
router.post('/', (req, res) => handleSentimentAnalysis(req, res));

export default router;
