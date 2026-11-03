// REGULATORY_FILING_MONITOR signal endpoint. Given a company name, product,
// drug, device, or industry concern, reports real filed or published
// documents with dates, from two public sources:
//   - the Federal Register (agency rules, notices, enforcement documents), and
//   - SEC EDGAR, when the subject is a US-listed company: its latest 10-K,
//     10-Q, 8-K and similar filings.
// Real routed questions seen live ("Will FDA fine B. Braun?", "Will FDA issue
// a warning for Ioversol?") phrase the ask as a prediction, but this answers
// from what has actually been published, never a forecast of future agency
// action. The SEC filing leads the answer only when the question is about a
// company's filings (it names a filing type or says "filing", "disclosure")
// or the Federal Register has nothing; otherwise the answer is the Federal
// Register one, with the SEC filings added as data.

import { Router } from 'express';
import {
  searchRegulatoryFilings, RegulatoryUpstreamError, RegulatoryLookupError,
  FEDERAL_REGISTER_ATTRIBUTION,
} from '../lib/regulatoryFilings.js';
import { findSecCompany, recentFilings, formsFromText, SEC_ATTRIBUTION } from '../lib/financialData.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue, extractSubject, looksLikeSentence } from '../lib/entityExtract.js';

const router = Router();

const PARAM_KEYS = [
  'company', 'entity', 'name', 'product', 'drug', 'device', 'industry',
  'concern', 'subject', 'query', 'q', 'question', 'text', 'input', 'search',
];

const MAX_INPUT_CHARS = 500;

const FILING_WORDS_RE = /\b(10-?k|10-?q|8-?k|20-?f|40-?f|6-?k|s-1|proxy|annual report|quarterly report|current report|filings?|disclosures?|sec|edgar|earnings report|prospectus)\b/i;

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

const describeFiling = (f) => `${f.form}${f.period ? ` for the period ending ${f.period}` : ''}, filed ${f.filed}${f.items ? ` (items ${f.items})` : ''}`;

function summarizeSec(company, filings, result) {
  const [lead, ...rest] = filings;
  const parts = [`The most recent SEC filing from ${company.name} (${company.ticker}) is a ${describeFiling(lead)}.`];
  if (rest.length) parts.push(`Other recent filings: ${rest.slice(0, 3).map(describeFiling).join('; ')}.`);
  if (result?.documents.length) {
    parts.push(`It is also mentioned in ${result.total_matches} Federal Register document${result.total_matches === 1 ? '' : 's'}, the most relevant being "${result.documents[0].title}" (${result.documents[0].publication_date ?? 'undated'}).`);
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

  const filingQuestion = FILING_WORDS_RE.test(rawInput);
  // The subject first; the whole question only when it is clearly about filings.
  const company = (await findSecCompany(query)) ?? (filingQuestion && query !== rawInput ? await findSecCompany(rawInput) : null);

  const [fedSettled, secSettled] = await Promise.allSettled([
    searchRegulatoryFilings(query),
    company ? recentFilings(company, { forms: formsFromText(rawInput), limit: 5 }) : Promise.resolve([]),
  ]);
  const secFilings = secSettled.status === 'fulfilled' ? secSettled.value : [];
  const fed = fedSettled.status === 'fulfilled' ? fedSettled.value : null;

  if (!fed && !secFilings.length) {
    const err = fedSettled.reason;
    if (err instanceof RegulatoryLookupError) return respondUnusableInput(res, err.message);
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

  const secLeads = secFilings.length > 0 && (filingQuestion || !fed?.documents.length);
  const documents = fed?.documents ?? [];
  res.json({
    status: 'ok',
    summary: secLeads ? summarizeSec(company, secFilings, fed) : summarizeFilings(query, fed ?? { documents: [], total_matches: 0 }),
    confidence: secLeads ? 0.9 : (documents.length ? 0.75 : 0.6),
    canonical: ['regulatory-filing-monitor', query.toLowerCase()].join(':'),
    query,
    total_matches: fed?.total_matches ?? 0,
    documents,
    ...(company ? { company: { name: company.name, ticker: company.ticker, cik: company.cik }, sec_filings: secFilings } : {}),
    source: secLeads ? 'SEC EDGAR and Federal Register' : 'Federal Register',
    attribution: secLeads ? `${SEC_ATTRIBUTION} ${FEDERAL_REGISTER_ATTRIBUTION}` : FEDERAL_REGISTER_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleRegulatoryFilingMonitor(req, res));
router.post('/', (req, res) => handleRegulatoryFilingMonitor(req, res));

export default router;
