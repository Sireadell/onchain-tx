// One router shape for the intents that are answered by reasoning over the
// caller's own text (a piece of code, a contract clause, a model's answer)
// rather than by looking a fact up. chainsight-oracle wins all six of the
// intents built on this (SECURITY_REVIEW, LLM_OUTPUT_EVALUATION,
// CONTRACT_OBLIGATION_AUDIT, CODE_GENERATION, CODE_REVIEW,
// TEXT_AUTHENTICITY_CHECK) with one model call per question and a single
// concise answer field; the competing specialist miners on them query
// GitHub or dataset APIs with fixed defaults and mostly fail. So each
// intent here is a prompt plus the list of parameter names a caller is
// likely to put its text under.

import { Router } from 'express';
import { llmComplete, hasLlmProvider, LlmCompleteError, capInput, frameInput } from './llmComplete.js';
import { respondUnusableInput } from './unusableInput.js';

const GENERIC_KEYS = ['query', 'question', 'q', 'text', 'input', 'prompt', 'content', 'message', 'request'];

// Collects every usable text parameter, named ones first, as "name: value"
// lines. The Telegraph request builder splits one question across several
// params as often as it sends the whole thing in one, so reading only the
// first match would drop half of what was asked.
export function collectInput(params, keys) {
  if (!params || typeof params !== 'object') return '';
  const seen = new Set();
  const parts = [];
  for (const key of [...keys, ...GENERIC_KEYS, ...Object.keys(params)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    let value = params[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') value = JSON.stringify(value);
    value = String(value).trim();
    if (!value) continue;
    if (parts.some((p) => p.endsWith(value))) continue;
    parts.push(`${key}: ${value}`);
  }
  return parts.join('\n');
}

// Reads the leading verdict word the prompt asked for, so the structured
// field always matches the prose the grader reads.
export function leadingVerdict(text, verdicts) {
  if (!verdicts?.length) return null;
  const head = String(text ?? '').trim().slice(0, 60).toLowerCase();
  const found = [...verdicts].sort((a, b) => b.length - a.length).find((v) => head.startsWith(v.toLowerCase()));
  return found ?? null;
}

// Plain text for the answer field: no markdown emphasis, headings or
// citation markers. Code blocks are kept as-is for the code intents.
function tidy(text, { keepCode }) {
  let out = String(text ?? '').trim();
  if (!keepCode) {
    out = out.replace(/\*\*|__/g, '').replace(/^#+\s*/gm, '').replace(/\[\d+\]/g, '');
  }
  return out.trim();
}

export function makeLlmIntentRouter({
  intent, canonical, prompt, keys, verdicts = [], maxTokens = 500, keepCode = false, emptyHint,
}) {
  const router = Router();

  async function handle(req, res) {
    const params = (req.method === 'GET' ? req.query : req.body) ?? {};
    const raw = collectInput(params, keys);

    if (!raw || !/[a-z0-9]/i.test(raw)) {
      return respondUnusableInput(res, emptyHint);
    }
    if (!hasLlmProvider()) {
      return res.status(503).json({
        status: 'error',
        summary: `${intent} is not configured on this deployment.`,
        confidence: 0,
        error: 'PERPLEXITY_API_KEY is not set',
      });
    }

    const { text: input } = capInput(raw);
    let result;
    try {
      result = await llmComplete(prompt, frameInput(input), {
        budgetMs: 20_000, maxTokens, disableSearch: true, temperature: 0.1, keepFormatting: keepCode,
      });
    } catch (err) {
      const upstream = err instanceof LlmCompleteError;
      return res.status(502).json({
        status: 'error',
        summary: upstream ? `${intent} is temporarily unavailable. Retry shortly.` : `${intent} failed`,
        confidence: 0,
        error: err.message,
      });
    }

    const summary = tidy(result?.text, { keepCode });
    if (!summary) {
      return respondUnusableInput(res, `No usable ${intent} answer could be produced for this input. Try rephrasing it.`);
    }

    const verdict = leadingVerdict(summary, verdicts);
    res.json({
      status: 'ok',
      summary,
      ...(verdict ? { verdict } : {}),
      confidence: verdict || !verdicts.length ? 0.8 : 0.6,
      canonical: [canonical, input.slice(0, 80)].join(':'),
      cost_usd: result.cost_usd ?? null,
      checked_at: new Date().toISOString(),
    });
  }

  router.get('/', (req, res) => handle(req, res));
  router.post('/', (req, res) => handle(req, res));
  return router;
}
