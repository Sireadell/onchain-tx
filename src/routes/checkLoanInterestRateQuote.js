// LOAN_INTEREST_RATE_QUOTE signal endpoint. Reads the current US mortgage
// rates (Freddie Mac) and the bank prime rate (derived from the Fed's target
// range, published by the New York Fed). Accepts a loan type as a param or
// inside a whole question; with no type named it answers the 30-year
// mortgage, the usual benchmark, and lists the other rates alongside.

import { Router } from 'express';
import {
  fetchLoanRates, resolveLoanType, LOAN_TYPES, LoanRatesUpstreamError, LoanRatesLookupError,
  PMMS_ATTRIBUTION, NYFED_ATTRIBUTION, weekOnOrBefore, yearContext,
} from '../lib/loanRates.js';
import { pastDateFromText } from './newData.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const TYPE_PARAM_KEYS = ['loan_type', 'type', 'product', 'rate_type', 'loan'];
const FREE_TEXT_KEYS = ['query', 'q', 'question', 'text', 'input', 'search'];
const MAX_INPUT_CHARS = 400;

const US_STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];
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
      // A 200 with the fields named, never a 5xx: a 5xx is booked as no answer.
      return res.json({
        status: 'unavailable',
        verdict: 'unavailable',
        summary: 'The Freddie Mac and New York Fed rate files did not answer at request time, so no rate is stated rather than an old one guessed.',
        confidence: 0.3,
        rate_percent: null,
        error: err.message,
        checked_at: new Date().toISOString(),
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

  // Context read from the same weekly file: the level a year earlier, the
  // 52 week range, and the week the question asked about when it named a date.
  const askText = [freeText, typeText].filter((v) => typeof v === 'string').join(' ').slice(0, MAX_INPUT_CHARS);
  const seriesKey = headlineType === 'prime' ? null : headlineType;
  let asked = null;
  let year = null;
  if (seriesKey && Array.isArray(mortgage?.history)) {
    year = yearContext(mortgage.history, seriesKey);
    const askedDate = pastDateFromText(askText);
    const week = askedDate && askedDate < asOf ? weekOnOrBefore(mortgage.history, askedDate) : null;
    if (week && week[seriesKey] !== null && week.date !== asOf) {
      asked = { requested_date: askedDate, week: week.date, percent: week[seriesKey] };
      summary = `For the survey week of ${week.date} (the week containing ${askedDate}), the average US ${label} rate was ${pct(week[seriesKey])} (Freddie Mac survey average, not an APR). The latest reading is ${pct(entry.percent)} for the week of ${asOf}.${note ? ` ${note}` : ''}${extras.length ? ` For comparison, ${extras.join(' and ')}.` : ''}`;
    }
    if (year) summary += ` A year earlier, in the week of ${year.year_ago_date}, it was ${pct(year.year_ago_percent)}; over the last 52 weeks it ranged from ${pct(year.low_52w)} to ${pct(year.high_52w)}.`;
  }
  const state = US_STATES.find((st) => new RegExp(`\\b${st}\\b`, 'i').test(askText));
  if (state && headlineType !== 'prime') summary += ` Freddie Mac publishes a national average only, with no separate ${state} figure, so this US average is the benchmark for ${state}.`;
  if (/\bAPR\b|annual percentage rate/i.test(askText) && headlineType !== 'prime') summary += ' The survey reports the interest rate on a loan with a 20 percent down payment, not an APR, which also includes fees and points.';

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
    ...(asked ? { requested_week: asked } : {}),
    ...(year ? { year_context: year } : {}),
    fed_target_range: prime ? { from: prime.fed_target_from, to: prime.fed_target_to } : null,
    source: headlineType === 'prime' ? 'New York Fed' : 'Freddie Mac PMMS',
    attribution: headlineType === 'prime' ? NYFED_ATTRIBUTION : PMMS_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleLoanInterestRateQuote(req, res));
router.post('/', (req, res) => handleLoanInterestRateQuote(req, res));

export default router;
