// CONTENT_MODERATION signal endpoint. Given text, decide whether it
// violates common platform policies, via lib/llmComplete.js (Perplexity).
// Params: text (required, also accepted as content/message/comment/post/
// input/question/query/q).
//
// The only real traffic in 11 days was two auto-generated "Will X
// injection enter Phase 2?" prediction questions dumped here by the
// router; the miner that took them answered that nothing harmful was
// found. So a question with no policy concern in it is "Safe" with a short
// reason, not a refusal.

import { Router } from 'express';
import { llmComplete, hasLlmProvider, LlmCompleteError, capInput, INJECTION_GUARD, frameInput } from '../lib/llmComplete.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const SYSTEM_PROMPT = 'You are a content moderation assistant for an automated system. Decide whether the user\'s text violates common '
  + 'platform policies: hate speech or demeaning generalisations about a protected group, harassment or personal abuse, violence or threats, '
  + 'sexual content involving minors, self-harm promotion, instructions for crimes, or sale of illegal or counterfeit goods. '
  + 'If the text is a question or instruction about moderating some other quoted text, judge the quoted text. '
  + 'Respond in the form "Safe. <one short sentence saying no concern was found>." or "Flagged. <one short sentence naming the concern>." '
  + 'The first word must be Safe when you found no concern and Flagged only when you name a concern. Use no markdown and no citation markers.'
  + INJECTION_GUARD;

const LEAD_RE = /^(Safe|Flagged)\b/i;
const ANY_RE = /\b(safe|flagged)\b/i;

// The model occasionally leads with "Flagged" and then explains that
// nothing was found. The reason is the more considered half of the reply,
// so a Flagged label sitting on a "no concern" reason is read as Safe.
const NO_CONCERN_RE = /\b(?:no|does not|doesn't|not)\b[^.]{0,80}\b(?:concern|violat|indicat|harmful|policy|threat|hate|harass)/i;

export function normaliseReply(text) {
  const reply = String(text ?? '').trim();
  let label = null;
  let summary = reply;
  const lead = reply.match(LEAD_RE);
  if (lead) {
    label = lead[1].toLowerCase() === 'flagged' ? 'Flagged' : 'Safe';
  } else {
    const any = reply.match(ANY_RE);
    if (any) {
      label = any[1].toLowerCase() === 'flagged' ? 'Flagged' : 'Safe';
      summary = `${label}. ${reply}`;
    }
  }
  if (label === 'Flagged') {
    const reason = summary.replace(LEAD_RE, '').replace(/^[.:\s]+/, '');
    if (NO_CONCERN_RE.test(reason) && !/\b(?:but|however|although)\b/i.test(reason)) {
      label = 'Safe';
      summary = `Safe. ${reason}`;
    }
  }
  return { label, summary };
}

async function handleContentModeration(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawText = firstUsableValue(
    params?.text, params?.content, params?.message, params?.comment, params?.post, params?.input,
    params?.question, params?.query, params?.q, params?.prompt,
  );

  if (!rawText || !String(rawText).trim()) {
    return respondUnusableInput(
      res,
      'I cannot moderate content because no text was supplied. Pass the text as the text parameter and I will return whether it is safe or flagged, with a brief reason.',
    );
  }

  if (!hasLlmProvider()) {
    return res.status(503).json({
      status: 'error',
      summary: 'Content moderation is not configured on this deployment.',
      confidence: 0,
      error: 'PERPLEXITY_API_KEY is not set',
    });
  }

  const { text, truncated } = capInput(rawText);

  let result;
  try {
    result = await llmComplete(SYSTEM_PROMPT, frameInput(text), { maxTokens: 150, disableSearch: true, temperature: 0 });
  } catch (err) {
    if (err instanceof LlmCompleteError) {
      return res.status(502).json({ status: 'error', summary: 'content moderation service failed', confidence: 0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'content moderation failed', confidence: 0, error: err.message });
  }

  if (!result) {
    return respondUnusableInput(res, 'The content moderation service returned nothing usable for this text. Try rephrasing it.');
  }

  const { label, summary } = normaliseReply(result.text);

  res.json({
    text,
    status: 'ok',
    summary: truncated ? `${summary} (Only the first ${text.length} characters of the text were read.)` : summary,
    flagged: label ? label === 'Flagged' : null,
    confidence: label ? 0.9 : 0.6,
    canonical: ['content-moderation', text.slice(0, 80)].join(':'),
    cost_usd: result.cost_usd,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleContentModeration(req, res));
router.post('/', (req, res) => handleContentModeration(req, res));

export default router;
