// REGULATORY_FILING_MONITOR signal endpoint. Given a company name, product,
// drug, device, or industry concern, searches the Federal Register for real
// filed/published regulatory documents and reports the most relevant ones
// with dates. Real routed questions seen live ("Will FDA fine B. Braun?",
// "Will FDA issue a warning for Ioversol?") phrase the ask as a prediction,
// but this answers from what has actually been published, never a forecast
// of future agency action.

import { Router } from 'express';
import {
  searchRegulatoryFilings, RegulatoryUpstreamError, RegulatoryLookupError,
  FEDERAL_REGISTER_ATTRIBUTION,
} from '../lib/regulatoryFilings.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue, extractSubject, looksLikeSentence } from '../lib/entityExtract.js';

const router = Router();

const PARAM_KEYS = [
  'company', 'entity', 'name', 'product', 'drug', 'device', 'industry',
  'concern', 'subject', 'query', 'q', 'question', 'text', 'input', 'search',
];

const MAX_INPUT_CHARS = 500;

function summarizeFilings(query, result) {
  if (!result.documents.length) {
    return `No Federal Register filings were found mentioning ${query}. That means no matching regulatory document has been published there, not that no future action could ever occur.`;
  }
  const lead = result.documents[0];
  const parts = [];
  const agencyText = lead.agencies.length ? ` from ${lead.agencies.join(', ')}` : '';
  parts.push(`The most relevant Federal Register filing for ${query} is "${lead.title}"${agencyText}, published ${lead.publication_date ?? 'on an unspecified date'}.`);
  if (lead.abstract) parts.push(String(lead.abstract).slice(0, 300));
  if (result.documents.length > 1) {
    parts.push(`${result.total_matches} total document${result.total_matches === 1 ? '' : 's'} matched; ${result.documents.length} are listed below.`);
  }
  parts.push('This reports what has actually been filed or published, not a prediction of future regulatory action.');
  return parts.join(' ');
}

async function handleRegulatoryFilingMonitor(req, res) {
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
      'I cannot check for regulatory filings because no company, product, drug, device, or concern was supplied. Pass a name or term as the company parameter.',
    );
  }

  const query = looksLikeSentence(rawInput) ? (extractSubject(rawInput) ?? rawInput) : rawInput;
  if (!query || query.length < 2) {
    return respondUnusableInput(
      res,
      `${quoteParam(rawInput)} does not name a company, product, or concern to search Federal Register filings for.`,
    );
  }

  let result;
  try {
    result = await searchRegulatoryFilings(query);
  } catch (err) {
    if (err instanceof RegulatoryLookupError) {
      return respondUnusableInput(res, err.message);
    }
    if (err instanceof RegulatoryUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: 'The Federal Register API is temporarily unavailable, so filings could not be checked right now. Retry shortly.',
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  res.json({
    status: 'ok',
    summary: summarizeFilings(query, result),
    confidence: result.documents.length ? 0.75 : 0.6,
    canonical: ['regulatory-filing-monitor', query.toLowerCase()].join(':'),
    query,
    total_matches: result.total_matches,
    documents: result.documents,
    source: 'Federal Register',
    attribution: FEDERAL_REGISTER_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleRegulatoryFilingMonitor(req, res));
router.post('/', (req, res) => handleRegulatoryFilingMonitor(req, res));

export default router;
