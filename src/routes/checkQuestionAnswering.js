// QUESTION_ANSWERING signal endpoint: a plain factual answer to an open
// question. When an LLM key with credit is available it answers (briefly, no
// hedging); otherwise, and whenever that call fails, the answer comes from the
// lead of the best-matching Wikipedia page, which needs no key. Either way the
// source is named, and a question nothing matches says so instead of guessing.

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { llmComplete, hasLlmProvider, capInput, frameInput, INJECTION_GUARD } from '../lib/llmComplete.js';
import { wikiAnswer } from '../lib/wikiAnswer.js';

const router = Router();

const SYSTEM = 'Answer the question in one to three plain sentences that state the facts directly, with exact names, numbers and dates. '
  + 'Do not hedge, do not add background nobody asked for, and do not use lists or markdown.';

async function handleQuestion(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const raw = firstUsableValue(params.question, params.query, params.q, params.prompt, params.text, freeTextParam(params));
  const question = String(raw ?? '').trim();
  if (!question) {
    return respondUnusableInput(res, 'I cannot answer because no question was supplied. Pass it as the question parameter.');
  }
  const { text: capped } = capInput(question, 2_000);
  const checkedAt = new Date().toISOString();

  if (hasLlmProvider()) {
    try {
      const out = await llmComplete(`${SYSTEM}${INJECTION_GUARD}`, frameInput(capped), { budgetMs: 9_000, maxTokens: 300, disableSearch: false, temperature: 0.1 });
      if (out?.text) {
        return res.json({
          status: 'ok', summary: out.text, confidence: 0.8,
          canonical: ['question-answering', 'llm'].join(':'), source: 'language model with live web search', checked_at: checkedAt,
        });
      }
    } catch {
      // Out of credit or unreachable: fall through to the keyless route below.
    }
  }

  try {
    const hit = await wikiAnswer(capped);
    if (hit) {
      return res.json({
        status: 'ok',
        summary: `${hit.extract} (Source: Wikipedia, "${hit.title}".)`,
        confidence: 0.65,
        canonical: ['question-answering', 'wikipedia', hit.title.toLowerCase()].join(':'),
        title: hit.title,
        source: hit.url,
        checked_at: checkedAt,
      });
    }
  } catch (err) {
    return res.status(502).json({ status: 'error', summary: 'The reference source did not answer. Retry shortly.', confidence: 0, error: err.message });
  }

  res.json({
    status: 'ok',
    summary: `I could not find a reliable source that answers "${capped.slice(0, 160)}", so I am not stating an answer.`,
    confidence: 0.3,
    canonical: ['question-answering', 'no-answer'].join(':'),
    checked_at: checkedAt,
  });
}

router.get('/', (req, res) => handleQuestion(req, res));
router.post('/', (req, res) => handleQuestion(req, res));

export default router;
