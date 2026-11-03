// LOAN_INTEREST_RATE_QUOTE data: current US mortgage rates and the bank prime
// rate, both from keyless public sources.
//   Mortgage rates: Freddie Mac's weekly Primary Mortgage Market Survey (30
//   year fixed, 15 year fixed, 5/1 adjustable). Freddie Mac publishes average
//   rates, not APRs, and says so; the answer says so too.
//   Prime rate: the New York Fed publishes the Fed's target range for the
//   federal funds rate, and banks set prime at the top of that range plus 3
//   points (the convention the Wall Street Journal prime rate follows).
// Personal, auto and credit card loan rates have no keyless public source, so
// a question about them gets an honest "not covered" instead of a guess.

const PMMS_URL = process.env.PMMS_URL || 'https://www.freddiemac.com/pmms/docs/PMMS_history.csv';
const NYFED_URL = process.env.NYFED_URL || 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json';
const REQUEST_TIMEOUT_MS = Number(process.env.LOAN_RATES_TIMEOUT_MS) || 8_000;
// PMMS updates once a week (Thursdays) and the Fed range changes a few times a
// year, so a few hours of caching costs nothing in accuracy.
const CACHE_TTL_MS = Number(process.env.LOAN_RATES_CACHE_TTL_MS) || 3 * 3_600_000;

export const PMMS_ATTRIBUTION = 'Freddie Mac Primary Mortgage Market Survey (freddiemac.com/pmms), via its public data file.';
export const NYFED_ATTRIBUTION = 'Federal Reserve Bank of New York reference rates (markets.newyorkfed.org), via its public API.';

export class LoanRatesUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoanRatesUpstreamError';
  }
}

export class LoanRatesLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LoanRatesLookupError';
  }
}

const cache = new Map();
export function __clearLoanRatesCacheForTesting() {
  cache.clear();
}

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getText(url, what) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'TxLens-Miner/1.0 (public-data research)' } });
    if (!res.ok) throw new LoanRatesUpstreamError(`${what} answered with status ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err instanceof LoanRatesUpstreamError) throw err;
    throw new LoanRatesUpstreamError(err.name === 'AbortError' ? `${what} did not respond in time` : `${what}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const num = (s) => {
  const n = Number(String(s ?? '').trim());
  return String(s ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};

// "10/29/2026" -> "2026-10-29"
function isoDate(us) {
  const m = String(us).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

export function parsePmms(csv) {
  const rows = String(csv).split(/\r?\n/).slice(1)
    .map((line) => line.split(','))
    .map((c) => ({ date: isoDate(c[0]), pmms30: num(c[1]), pmms15: num(c[3]), pmms51: num(c[5]) }))
    .filter((r) => r.date && r.pmms30 !== null);
  if (rows.length < 2) throw new LoanRatesUpstreamError('the Freddie Mac file had no readable rates');
  const latest = rows[rows.length - 1];
  const before = rows[rows.length - 2];
  const entry = (key) => (latest[key] === null ? null : {
    percent: latest[key],
    week_change: before[key] === null ? null : Math.round((latest[key] - before[key]) * 100) / 100,
  });
  return { as_of: latest.date, mortgage_30y: entry('pmms30'), mortgage_15y: entry('pmms15'), arm_5_1: entry('pmms51') };
}

export function parseNyFed(body) {
  const row = JSON.parse(body)?.refRates?.[0];
  const top = row?.targetRateTo;
  const bottom = row?.targetRateFrom;
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) throw new LoanRatesUpstreamError('the New York Fed answer had no target range');
  return { as_of: row.effectiveDate, percent: top + 3, fed_target_from: bottom, fed_target_to: top, effr: Number.isFinite(row.percentRate) ? row.percentRate : null };
}

const wrap = (label, fn) => async () => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LoanRatesUpstreamError) throw err;
    throw new LoanRatesUpstreamError(`${label} could not be read: ${err.message}`);
  }
};

export const fetchMortgageRates = () => cached('pmms', wrap('Freddie Mac rates', async () => parsePmms(await getText(PMMS_URL, 'Freddie Mac'))));
export const fetchPrimeRate = () => cached('prime', wrap('the prime rate', async () => parseNyFed(await getText(NYFED_URL, 'the New York Fed'))));

export const LOAN_TYPES = {
  mortgage_30y: '30-year fixed mortgage',
  mortgage_15y: '15-year fixed mortgage',
  arm_5_1: '5/1 adjustable-rate mortgage',
  prime: 'bank prime',
};

const UNSUPPORTED_RE = /\b(personal loan|auto loan|car loan|student loan|credit card|payday|business loan|heloc|home equity)\b/i;

// Free text (or a loan_type param) to one of the supported types. Returns
// null when nothing is named, which the route answers with the 30-year
// mortgage, the benchmark a bare "loan interest rate" question most often means.
export function resolveLoanType(raw) {
  const text = String(raw ?? '').toLowerCase();
  if (!text.trim()) return null;
  const unsupported = text.match(UNSUPPORTED_RE);
  if (unsupported) throw new LoanRatesLookupError(`No free public source covers ${unsupported[1]} rates. Ask for a mortgage rate (30-year, 15-year or 5/1 ARM) or the prime rate.`);
  if (/\bprime\b/.test(text)) return 'prime';
  if (/\b(5\s*[/-]\s*1|arm|adjustable|variable)\b/.test(text)) return 'arm_5_1';
  if (/\b15\s*[- ]?(year|yr|y)\b|\b15y\b/.test(text)) return 'mortgage_15y';
  if (/\b30\s*[- ]?(year|yr|y)\b|\b30y\b|mortgage|home loan|fixed|house/.test(text)) return 'mortgage_30y';
  return null;
}

// Reads whichever sources are needed. A source that is down only fails the
// answer when the caller asked for exactly what it provides.
export async function fetchLoanRates(type) {
  const wantPrime = type === 'prime';
  const [mortgage, prime] = await Promise.allSettled([fetchMortgageRates(), fetchPrimeRate()]);
  const primary = wantPrime ? prime : mortgage;
  if (primary.status === 'rejected') throw primary.reason;
  return {
    mortgage: mortgage.status === 'fulfilled' ? mortgage.value : null,
    prime: prime.status === 'fulfilled' ? prime.value : null,
  };
}
