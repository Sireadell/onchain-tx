// TEXT_CLASSIFICATION signal endpoint. Assigns a category to a piece of
// text. Params: text (required, also accepted as content/input/question/
// query/q/message/document/sentence). Optional: labels (comma-separated
// candidate categories, also accepted as categories/classes/options). If
// given, the model must pick one of these rather than inventing its own.
// The question itself often carries the candidate set ("classify this as
// spam or not spam: ..."), and the model is told to honour that too.
//
// No real traffic has reached this intent yet (0 routed questions in 11
// days), so the shape here is set against the synthetic bank: the graded
// text leads with the label word, then one short reason.

import { Router } from 'express';
import { llmComplete, hasLlmProvider, LlmCompleteError, capInput, INJECTION_GUARD, frameInput } from '../lib/llmComplete.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

function buildSystemPrompt(labels) {
  const base = 'You are a text classifier for an automated system. '
    + 'Read the text you are given and reply with the single best category it belongs to, then one short sentence saying why. '
    + 'The category word or phrase must be the very first thing in your reply, followed by a period; do not write "Category:" or "Classification:" in front of it. '
    + 'If the text itself names the categories to choose from, pick one of those using its exact wording; otherwise choose a short, conventional category name. '
    + 'Use no markdown, no bullet points, no headings, and no citation markers.';
  const guarded = base + INJECTION_GUARD;
  if (!labels || labels.length === 0) return guarded;
  return `${guarded} You must pick exactly one of these categories, using its exact wording: ${labels.join(', ')}.`;
}

// The reply leads with the label, so the label is whatever comes before
// the first sentence break. "Category:" style prefixes are removed first
// in case the model ignored the instruction.
const PREFIX_RE = /^(?:category|classification|class|label|type|result)\s*[:\-]\s*/i;

export function extractLabel(text) {
  const cleaned = String(text ?? '').replace(PREFIX_RE, '').trim();
  const m = cleaned.match(/^([^.:;!?\n]{1,60}?)\s*(?:[.:;!?]|$)/);
  return { cleaned, label: m ? m[1].trim() : null };
}

function parseLabels(value) {
  if (typeof value !== 'string') return null;
  const list = value.split(',').map((l) => l.trim()).filter(Boolean).slice(0, 30);
  return list.length ? list : null;
}

async function handleTextClassification(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawText = firstUsableValue(
    params?.text, params?.content, params?.input, params?.question, params?.query,
    params?.q, params?.message, params?.document, params?.sentence, params?.prompt,
  );

  if (!rawText || !String(rawText).trim()) {
    return respondUnusableInput(
      res,
      'I cannot classify anything because no text was supplied. Pass the text as the text parameter and I will return the single best category it belongs to. Optionally pass labels as a comma-separated list to restrict the categories I can pick from.',
    );
  }

  if (!hasLlmProvider()) {
    return res.status(503).json({
      status: 'error',
      summary: 'Text classification is not configured on this deployment.',
      confidence: 0,
      error: 'PERPLEXITY_API_KEY is not set',
    });
  }

  const labels = parseLabels(firstUsableValue(params?.labels, params?.categories, params?.classes, params?.options));
  const { text, truncated } = capInput(rawText);

  let result;
  try {
    result = await llmComplete(buildSystemPrompt(labels), frameInput(text), { maxTokens: 150, disableSearch: true, temperature: 0 });
  } catch (err) {
    if (err instanceof LlmCompleteError) {
      return res.status(502).json({
        status: 'error',
        summary: `Text classification is temporarily unavailable for ${quoteParam(rawText)}. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    return res.status(502).json({ status: 'error', summary: 'text classification failed', confidence: 0, error: err.message });
  }

  if (!result) {
    return respondUnusableInput(res, `No category could be determined for ${quoteParam(rawText)}. Try rephrasing or shortening the text.`);
  }

  const { cleaned, label } = extractLabel(result.text);

  res.json({
    text,
    status: 'ok',
    summary: truncated
      ? `${cleaned} (Only the first ${text.length} characters of the text were read.)`
      : cleaned,
    // Named classification, not category: miner.yaml already declares
    // category as /ssl-check's enum of certificate verdicts, and one output
    // schema covers every route.
    classification: label,
    confidence: label ? 0.9 : 0.6,
    canonical: ['text-classification', text.slice(0, 80)].join(':'),
    labels: labels ?? null,
    cost_usd: result.cost_usd,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleTextClassification(req, res));
router.post('/', (req, res) => handleTextClassification(req, res));

export default router;
