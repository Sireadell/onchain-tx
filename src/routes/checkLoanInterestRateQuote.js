// LOAN_INTEREST_RATE_QUOTE signal endpoint. Reads the current US mortgage
// rates (Freddie Mac) and the bank prime rate (derived from the Fed's target
// range, published by the New York Fed). Accepts a loan type as a param or
// inside a whole question; with no type named it answers the 30-year
// mortgage, the usual benchmark, and lists the other rates alongside.

import { Router } from 'express';
import {
  fetchLoanRates, resolveLoanType, LOAN_TYPES, LoanRatesUpstreamError, LoanRatesLookupError,
  PMMS_ATTRIBUTION, NYFED_ATTRIBUTION,
} from '../lib/loanRates.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const TYPE_PARAM_KEYS = ['loan_type', 'type', 'product', 'rate_type', 'loan'];
const FREE_TEXT_KEYS = ['query', 'q', 'question', 'text', 'input', 'search'];
const MAX_INPUT_CHARS = 400;

const pct = (n) => `${n.toFixed(2)}%`;
const change = (c) => (c === null || c === 0 ? 'unchanged' : `${c > 0 ? 'up' : 'down'} ${Math.abs(c).toFixed(2)} points`);

async function handleLoanInterestRateQuote(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const typeText = firstUsableValue(...TYPE_PARAM_KEYS.map((k) => params[k]));
  const freeText = firstUsableValue(...FREE_TEXT_KEYS.map((k) => params[k]));

  let type;
  try {
    type = resolveLoanType(String(typeText ?? '').slice(0, MAX_INPUT_CHARS))
      ?? resolveLoanType(String(freeText ?? '').slice(0, MAX_INPUT_CHARS))
      ?? 'mortgage_30y';
  } catch (err) {
    if (err instanceof LoanRatesLookupError) return respondUnusableInput(res, err.message);
    throw err;
  }

  let data;
  try {
    data = await fetchLoanRates(type);
  } catch (err) {
    if (err instanceof LoanRatesUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: 'The public rate sources are temporarily unavailable, so the rate could not be checked right now. Retry shortly.',
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  const { mortgage, prime } = data;
  let headlineType = type;
  let note = null;
  let entry = type === 'prime' ? (prime ? { percent: prime.percent, week_change: null } : null) : mortgage?.[type];
  if (!entry) {
    // Freddie Mac stopped publishing the 5/1 ARM in 2022; fall back to the benchmark.
    headlineType = 'mortgage_30y';
    entry = mortgage.mortgage_30y;
    note = `${LOAN_TYPES[type]} rates are no longer published by Freddie Mac, so the 30-year fixed mortgage rate is given instead.`;
  }

  const asOf = headlineType === 'prime' ? prime.as_of : mortgage.as_of;
  const label = LOAN_TYPES[headlineType];
  let summary;
  if (headlineType === 'prime') {
    summary = `The US bank prime rate is ${pct(entry.percent)} as of ${asOf}, which is the top of the Fed's ${pct(prime.fed_target_from)} to ${pct(prime.fed_target_to)} target range plus 3 points.`;
  } else {
    summary = `The average US ${label} rate was ${pct(entry.percent)} for the week of ${asOf}, ${change(entry.week_change)} from the week before (Freddie Mac survey average, not an APR).`;
  }
  if (note) summary += ` ${note}`;
  const extras = [];
  if (headlineType !== 'prime' && prime) extras.push(`the bank prime rate is ${pct(prime.percent)}`);
  if (headlineType !== 'mortgage_15y' && mortgage?.mortgage_15y) extras.push(`the 15-year fixed mortgage is ${pct(mortgage.mortgage_15y.percent)}`);
  if (extras.length) summary += ` For comparison, ${extras.join(' and ')}.`;

  res.json({
    status: 'ok',
    summary,
    confidence: 0.9,
    canonical: ['loan-interest-rate-quote', headlineType].join(':'),
    loan_type: headlineType,
    rate_percent: entry.percent,
    week_change: entry.week_change,
    as_of: asOf,
    rates: {
      mortgage_30y: mortgage?.mortgage_30y ?? null,
      mortgage_15y: mortgage?.mortgage_15y ?? null,
      arm_5_1: mortgage?.arm_5_1 ?? null,
      prime_percent: prime?.percent ?? null,
    },
    fed_target_range: prime ? { from: prime.fed_target_from, to: prime.fed_target_to } : null,
    source: headlineType === 'prime' ? 'New York Fed' : 'Freddie Mac PMMS',
    attribution: headlineType === 'prime' ? NYFED_ATTRIBUTION : PMMS_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleLoanInterestRateQuote(req, res));
router.post('/', (req, res) => handleLoanInterestRateQuote(req, res));

export default router;
