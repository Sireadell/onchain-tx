// Central bank policy interest rates, read straight from each central bank's
// own public data (no keys):
//   US    Fed target range and effective rate: New York Fed reference rates
//   EA    ECB deposit facility and main refinancing rates: ECB data portal
//   CA    Bank of Canada overnight rate target: Bank of Canada Valet API
//   GB    Bank of England Bank Rate: Bank of England statistical database
// Other central banks are not covered and a question about one is told so.

import { fetchPrimeRate } from './loanRates.js';

const ECB_BASE = process.env.ECB_BASE || 'https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR';
const BOC_URL = process.env.BOC_URL || 'https://www.bankofcanada.ca/valet/observations/V39079/json?recent=1';
const BOE_BASE = process.env.BOE_BASE || 'https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp';
const REQUEST_TIMEOUT_MS = Number(process.env.POLICY_RATES_TIMEOUT_MS) || 8_000;
const CACHE_TTL_MS = Number(process.env.POLICY_RATES_CACHE_TTL_MS) || 3 * 3_600_000;

export const POLICY_REGIONS = {
  US: 'the United States',
  EA: 'the euro area',
  CA: 'Canada',
  GB: 'the United Kingdom',
};

export class PolicyRateUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyRateUpstreamError';
  }
}

const cache = new Map();
export function __clearPolicyRatesCacheForTesting() {
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
    if (!res.ok) throw new PolicyRateUpstreamError(`${what} answered with status ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err instanceof PolicyRateUpstreamError) throw err;
    throw new PolicyRateUpstreamError(err.name === 'AbortError' ? `${what} did not respond in time` : `${what}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Which central bank a question is about ----------------------------------

const EURO_COUNTRIES = 'germany|france|italy|spain|netherlands|belgium|austria|portugal|ireland|finland|greece|luxembourg|slovakia|slovenia|estonia|latvia|lithuania|cyprus|malta|croatia';

// Returns 'US' | 'EA' | 'CA' | 'GB', or null when no supported central bank
// is named. "US" in capitals counts; lowercase "us" is just a word.
export function resolvePolicyRegion(raw) {
  const text = String(raw ?? '');
  const t = text.toLowerCase();
  if (/\b(ecb|euro ?area|euro ?zone|european central bank|europe|european union)\b/.test(t) || new RegExp(`\\b(${EURO_COUNTRIES})\\b`).test(t)) return 'EA';
  if (/\b(bank of england|boe|united kingdom|britain|british|england|uk)\b/.test(t) || /\bU\.K\./.test(text)) return 'GB';
  if (/\b(bank of canada|boc|canada|canadian)\b/.test(t)) return 'CA';
  if (/\b(fed|fomc|federal reserve|federal funds|united states|usa|america|american)\b/.test(t) || /\bU\.?S\.?\b/.test(text)) return 'US';
  return null;
}

export const POLICY_RATE_RE = /\b(interest rates?|policy rates?|base rate|bank rate|key rate|benchmark rate|overnight rate|refinancing rate|deposit (facility )?rate|repo rate|discount rate|fed funds|federal funds|fomc|central bank rates?|rate (hike|cut|decision))\b/i;

// ---- Readers -------------------------------------------------------------------

const num = (s) => {
  const n = Number(String(s ?? '').trim());
  return String(s ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};

// Last data row of an ECB csv download: { date, percent }.
export function parseEcbCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  const header = lines[0]?.split(',') ?? [];
  const dateAt = header.indexOf('TIME_PERIOD');
  const valueAt = header.indexOf('OBS_VALUE');
  const cells = lines[lines.length - 1]?.split(',') ?? [];
  const percent = num(cells[valueAt]);
  if (lines.length < 2 || dateAt < 0 || percent === null) throw new PolicyRateUpstreamError('the ECB answer had no readable rate');
  return { date: cells[dateAt], percent };
}

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// "16 Sep 2026" -> "2026-09-16"
function isoFromBoe(text) {
  const m = String(text).trim().match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` : null;
}

export function parseBoeCsv(csv) {
  const rows = String(csv).trim().split(/\r?\n/).slice(1)
    .map((l) => l.split(','))
    .map((c) => ({ date: isoFromBoe(c[0]), percent: num(c[1]) }))
    .filter((r) => r.date && r.percent !== null);
  const last = rows[rows.length - 1];
  if (!last) throw new PolicyRateUpstreamError('the Bank of England answer had no readable rate');
  return last;
}

export function parseBocJson(body) {
  const obs = JSON.parse(body)?.observations?.[0];
  const percent = num(obs?.V39079?.v);
  if (!obs?.d || percent === null) throw new PolicyRateUpstreamError('the Bank of Canada answer had no readable rate');
  return { date: obs.d, percent };
}

const wrap = (label, fn) => async () => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PolicyRateUpstreamError) throw err;
    throw new PolicyRateUpstreamError(`${label} could not be read: ${err.message}`);
  }
};

const boeDateFrom = () => {
  const d = new Date(Date.now() - 45 * 86_400_000);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, '0')}/${mon}/${d.getUTCFullYear()}`;
};

// One result shape for every region: { region, bank, rate_name, percent, as_of, ... }.
export async function fetchPolicyRate(region) {
  if (region === 'US') {
    const us = await fetchPrimeRate();
    return {
      region, bank: 'Federal Reserve', rate_name: 'federal funds target range', percent: us.effr ?? us.fed_target_to,
      range: { from: us.fed_target_from, to: us.fed_target_to }, effective_rate: us.effr ?? null, as_of: us.as_of,
      source: 'New York Fed reference rates (markets.newyorkfed.org)',
    };
  }
  if (region === 'EA') {
    return cached('EA', wrap('the ECB rates', async () => {
      const [deposit, refinancing] = await Promise.all([
        getText(`${ECB_BASE}.DFR.LEV?lastNObservations=1&format=csvdata`, 'the ECB').then(parseEcbCsv),
        getText(`${ECB_BASE}.MRR_FR.LEV?lastNObservations=1&format=csvdata`, 'the ECB').then(parseEcbCsv),
      ]);
      return {
        region, bank: 'European Central Bank', rate_name: 'deposit facility rate', percent: deposit.percent,
        deposit_facility: deposit, main_refinancing: refinancing,
        as_of: deposit.date > refinancing.date ? deposit.date : refinancing.date,
        source: 'ECB data portal (data.ecb.europa.eu)',
      };
    }));
  }
  if (region === 'CA') {
    return cached('CA', wrap('the Bank of Canada rate', async () => {
      const r = parseBocJson(await getText(BOC_URL, 'the Bank of Canada'));
      return { region, bank: 'Bank of Canada', rate_name: 'overnight rate target', percent: r.percent, as_of: r.date, source: 'Bank of Canada Valet API (bankofcanada.ca)' };
    }));
  }
  if (region === 'GB') {
    return cached('GB', wrap('the Bank Rate', async () => {
      const url = `${BOE_BASE}?csv.x=yes&Datefrom=${boeDateFrom()}&Dateto=now&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`;
      const r = parseBoeCsv(await getText(url, 'the Bank of England'));
      return { region, bank: 'Bank of England', rate_name: 'Bank Rate', percent: r.percent, as_of: r.date, source: 'Bank of England statistical database (bankofengland.co.uk)' };
    }));
  }
  throw new PolicyRateUpstreamError(`no central bank source for ${region}`);
}

const pct = (n) => `${n.toFixed(2)}%`;

export function policyRateSummary(r) {
  if (r.region === 'US') {
    return `The Federal Reserve's federal funds target range is ${pct(r.range.from)} to ${pct(r.range.to)}${r.effective_rate !== null ? `, and the effective federal funds rate was ${pct(r.effective_rate)}` : ''} as of ${r.as_of}.`;
  }
  if (r.region === 'EA') {
    return `The European Central Bank's deposit facility rate is ${pct(r.deposit_facility.percent)} (set ${r.deposit_facility.date}) and its main refinancing rate is ${pct(r.main_refinancing.percent)} (set ${r.main_refinancing.date}).`;
  }
  if (r.region === 'CA') return `The Bank of Canada's target for the overnight rate is ${pct(r.percent)} as of ${r.as_of}.`;
  return `The Bank of England's Bank Rate is ${pct(r.percent)} as of ${r.as_of}.`;
}
