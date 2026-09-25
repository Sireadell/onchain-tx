// CREDIT_SCORE_VERIFY signal endpoint. Given a company name, looks it up
// in GLEIF's LEI registry and reports whether it has a registered Legal
// Entity Identifier, its legal name and status. GLEIF registration is a
// real, honest signal that a business is genuine and formally registered,
// but it is explicitly NOT a credit score: GLEIF publishes no
// creditworthiness figure, so this endpoint never invents a numeric score.

import { Router } from 'express';
import {
  lookupEntity, EntityRegistryUpstreamError, EntityRegistryLookupError,
  GLEIF_ATTRIBUTION,
} from '../lib/entityRegistry.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue, extractSubject, looksLikeSentence } from '../lib/entityExtract.js';
import { searchWeb, hasWebSearchProvider } from '../lib/webSearch.js';

const router = Router();

// FICO and VantageScore are scoring models, not companies: GLEIF fuzzy-matches
// "FICO" to unrelated firms such as "FICO AGATA". A question about how credit
// scores work names no company at all. Both go to the web instead of the registry.
const SCORING_MODEL = /\b(fico|vantage ?score)\b/i;
const GENERAL_CREDIT_WORDS = /\b(range|ranges|factors?|good|bad|average|typical|lower|raise|improve|affect|affects|calculated|work|works|mean|means)\b/i;
const CREDIT_SCORE_PHRASE = /\bcredit scores?\b/i;
const WEB_BUDGET_MS = 8_000;

function isGeneralCreditQuestion(text) {
  if (SCORING_MODEL.test(text)) return true;
  return CREDIT_SCORE_PHRASE.test(text) && GENERAL_CREDIT_WORDS.test(text);
}

function generalQuestionText(rawInput) {
  const text = rawInput.replace(/\bCREDIT_SCORE_VERIFY\b/g, '').trim();
  if (looksLikeSentence(text)) return text;
  return `What is the ${text} credit score, what score range counts as good, and what factors lower a score?`;
}

async function answerGeneralCreditQuestion(res, rawInput) {
  const question = generalQuestionText(rawInput);
  let result = null;
  if (hasWebSearchProvider()) {
    try {
      result = await searchWeb(question, { budgetMs: WEB_BUDGET_MS });
    } catch {
      result = null;
    }
  }
  const answer = typeof result?.answer === 'string' ? result.answer.trim() : '';
  if (!answer) {
    return res.status(502).json({
      status: 'error',
      summary: 'The live source for general credit score information is temporarily unavailable, so this question could not be answered right now. Retry shortly.',
      confidence: 0,
    });
  }
  const sources = (result.results ?? []).slice(0, 3);
  const cited = sources.map((r) => `${r.title}${r.url ? ` (${r.url})` : ''}`).join('; ');
  const summary = sources.length
    ? `${answer} Answered from a live web search at request time, the most relevant sources being: ${cited}.`
    : `${answer} Answered from a live web search at request time.`;
  return res.json({
    status: 'ok',
    summary,
    confidence: 0.85,
    canonical: ['credit-score-verify', 'general', question.toLowerCase().slice(0, 80)].join(':'),
    query: question,
    credit_score_available: false,
    sources,
    provider: result.provider,
    checked_at: new Date().toISOString(),
  });
}

const PARAM_KEYS = [
  'company', 'entity', 'name', 'company_name', 'legal_name', 'business',
  'query', 'q', 'question', 'text', 'input', 'search',
];

const MAX_INPUT_CHARS = 400;

const CREDIT_SCORE_DISCLAIMER = 'This is not a credit score: GLEIF does not publish creditworthiness data, only whether an entity is registered in the global LEI system.';

function summarizeEntity(query, result) {
  if (!result.matches.length) {
    return `No registered Legal Entity Identifier (LEI) was found for ${query} in the GLEIF registry. That means either the entity is not registered in the global LEI system, or the name did not match closely enough. ${CREDIT_SCORE_DISCLAIMER}`;
  }
  const lead = result.matches[0];
  const statusText = lead.entity_status ? lead.entity_status.toLowerCase() : 'unknown status';
  const regText = lead.registration_status ? lead.registration_status.toLowerCase() : 'unknown';
  const parts = [
    `${lead.legal_name ?? query} has a registered LEI (${lead.lei}), a formal legal-entity registration, entity status ${statusText}, LEI registration status ${regText}${lead.jurisdiction ? ` in ${lead.jurisdiction}` : ''}.`,
    CREDIT_SCORE_DISCLAIMER,
  ];
  if (result.matches.length > 1) parts.splice(1, 0, `${result.matches.length} entities matched this name; the closest match is reported.`);
  return parts.join(' ');
}

async function handleCreditScoreVerify(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  const candidates = PARAM_KEYS.map((k) => params[k]);
  for (const [key, value] of Object.entries(params)) {
    if (!PARAM_KEYS.includes(key)) candidates.push(value);
  }
  const strings = candidates
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().slice(0, MAX_INPUT_CHARS));

  const rawInput = firstUsableValue(...strings);
  if (!rawInput) {
    return respondUnusableInput(
      res,
      'I cannot verify a business entity because no company name was supplied. Pass a company name as the company parameter.',
    );
  }

  if (isGeneralCreditQuestion(rawInput)) return answerGeneralCreditQuestion(res, rawInput);

  const query = looksLikeSentence(rawInput) ? (extractSubject(rawInput) ?? rawInput) : rawInput;
  if (!query || query.length < 2) {
    return respondUnusableInput(
      res,
      `${quoteParam(rawInput)} does not name a company to verify against the GLEIF entity registry.`,
    );
  }

  let result;
  try {
    result = await lookupEntity(query);
  } catch (err) {
    if (err instanceof EntityRegistryLookupError) {
      return respondUnusableInput(res, err.message);
    }
    if (err instanceof EntityRegistryUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: 'The GLEIF entity registry is temporarily unavailable, so this entity could not be verified right now. Retry shortly.',
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  res.json({
    status: 'ok',
    summary: summarizeEntity(query, result),
    confidence: result.matches.length ? 0.8 : 0.55,
    canonical: ['credit-score-verify', query.toLowerCase()].join(':'),
    query,
    lei_registered: result.matches.length > 0,
    credit_score_available: false,
    matches: result.matches,
    source: 'GLEIF',
    attribution: GLEIF_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleCreditScoreVerify(req, res));
router.post('/', (req, res) => handleCreditScoreVerify(req, res));

export default router;
