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

const router = Router();

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
