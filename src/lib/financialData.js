// FINANCIAL_DATA: company fundamentals (revenue, net income, assets and so on)
// for US-listed companies, read from the numbers each company itself filed
// with the SEC (EDGAR "company concept" data). No key, one polite request
// header. Annual figures come from 10-K filings (20-F and 40-F for foreign
// filers), quarterly figures from 10-Q filings. Companies that do not file
// with the SEC are reported as not found rather than guessed at.

const TICKERS_URL = process.env.SEC_TICKERS_URL || 'https://www.sec.gov/files/company_tickers.json';
const CONCEPT_BASE = process.env.SEC_CONCEPT_BASE || 'https://data.sec.gov/api/xbrl/companyconcept';
// The SEC asks every automated caller to identify itself.
const USER_AGENT = process.env.SEC_USER_AGENT || 'TxLens Miner sireadell@gmail.com';
const REQUEST_TIMEOUT_MS = Number(process.env.FINANCIAL_TIMEOUT_MS) || 8_000;
const TICKERS_TTL_MS = 6 * 3_600_000;
const CONCEPT_TTL_MS = Number(process.env.FINANCIAL_CACHE_TTL_MS) || 30 * 60_000;
const MAX_CACHE_ENTRIES = 400;

export const SEC_ATTRIBUTION = 'SEC EDGAR (sec.gov), the numbers each company filed in its own 10-K and 10-Q reports, via the public XBRL API.';

export class FinancialUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinancialUpstreamError';
  }
}

const cache = new Map();
export function __clearFinancialCacheForTesting() {
  cache.clear();
}

async function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

// 404 means "this company never used that tag", which is an answer, not an error.
async function getJson(url, { allow404 = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new FinancialUpstreamError(`SEC EDGAR answered with status ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err instanceof FinancialUpstreamError) throw err;
    throw new FinancialUpstreamError(err.name === 'AbortError' ? 'SEC EDGAR did not respond in time' : `SEC EDGAR: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Company lookup --------------------------------------------------------

const NAME_NOISE = new Set(['inc', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'plc', 'the', 'holdings', 'group', 'de', 'sa', 'nv', 'new']);
const normalize = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const coreName = (s) => normalize(s).split(' ').filter((w) => w && !NAME_NOISE.has(w)).join(' ');

async function loadCompanies() {
  return cached('tickers', TICKERS_TTL_MS, async () => {
    const body = await getJson(TICKERS_URL);
    const list = Object.values(body ?? {}).filter((c) => c?.cik_str && c?.ticker && c?.title);
    if (!list.length) throw new FinancialUpstreamError('the SEC company list was empty');
    const byTicker = new Map();
    for (const c of list) {
      const key = String(c.ticker).toUpperCase();
      if (!byTicker.has(key)) byTicker.set(key, { cik: Number(c.cik_str), ticker: key, name: c.title });
    }
    // The file is ordered largest company first, so the first company to claim
    // a name keeps it (Alphabet's two share classes, for instance).
    const byName = new Map();
    const byFirst = new Map();
    for (const c of byTicker.values()) {
      const core = coreName(c.name);
      if (core.length >= 3 && !byName.has(core)) byName.set(core, c);
      // "AMAZON COM INC" is asked about as "Amazon".
      const first = core.split(' ')[0];
      if (first.length >= 4 && !byFirst.has(first)) byFirst.set(first, c);
    }
    return { byTicker, byName, byFirst };
  });
}

// Words that are all capitals in a question but are not tickers.
const NOT_TICKERS = new Set(['US', 'USA', 'CEO', 'CFO', 'EPS', 'GDP', 'USD', 'SEC', 'IPO', 'ETF', 'AI', 'ARE', 'FOR', 'THE', 'WHAT', 'WAS', 'ITS', 'NET', 'ALL', 'YOY', 'TTM', 'FY', 'Q1', 'Q2', 'Q3', 'Q4', 'ROE', 'PE', 'P', 'A', 'I']);

// A company from a name, ticker or whole question. Returns null when the SEC
// has no such filer.
const ORDINARY_WORDS = new Set(['what', 'when', 'which', 'where', 'total', 'income', 'revenue', 'sales', 'profit', 'share', 'shares', 'assets', 'cash', 'annual', 'quarter', 'quarterly', 'latest', 'current', 'company', 'price', 'value', 'stock', 'report', 'financial', 'earnings', 'equity', 'debt', 'this', 'that', 'last', 'with', 'from', 'about', 'tell', 'show', 'give', 'fiscal', 'year', 'liabilities', 'operating', 'diluted']);

export async function resolveCompany(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const { byTicker, byName, byFirst } = await loadCompanies();
  // A short value from a `company` param is a name; a long one is a question.
  const explicit = text.split(/\s+/).length <= 4;

  const bare = text.replace(/^\$/, '').toUpperCase();
  if (/^[A-Z.\-]{1,6}$/.test(bare) && byTicker.has(bare) && !NOT_TICKERS.has(bare)) return byTicker.get(bare);

  const padded = ` ${normalize(text)} `;
  let best = null;
  for (const [core, company] of byName) {
    if (padded.includes(` ${core} `) && (!best || core.length > best.core.length)) best = { core, company };
  }
  if (best) return best.company;

  for (const word of text.split(/[^A-Za-z0-9]+/)) {
    const lower = word.toLowerCase();
    if (lower.length < 4 || ORDINARY_WORDS.has(lower) || !byFirst.has(lower)) continue;
    if (explicit || /^[A-Z]/.test(word)) return byFirst.get(lower);
  }

  for (const token of text.match(/\$?\b[A-Z]{2,5}\b/g) ?? []) {
    const t = token.replace('$', '');
    if (!NOT_TICKERS.has(t) && byTicker.has(t)) return byTicker.get(t);
  }
  return null;
}

// ---- Metrics ----------------------------------------------------------------

export const METRICS = {
  revenue: { label: 'revenue', kind: 'flow', unit: 'USD', tags: [['us-gaap', 'Revenues'], ['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'], ['us-gaap', 'SalesRevenueNet']] },
  net_income: { label: 'net income', kind: 'flow', unit: 'USD', tags: [['us-gaap', 'NetIncomeLoss'], ['us-gaap', 'ProfitLoss']] },
  operating_income: { label: 'operating income', kind: 'flow', unit: 'USD', tags: [['us-gaap', 'OperatingIncomeLoss']] },
  eps: { label: 'diluted earnings per share', kind: 'flow', unit: 'USD/shares', tags: [['us-gaap', 'EarningsPerShareDiluted'], ['us-gaap', 'EarningsPerShareBasic']] },
  total_assets: { label: 'total assets', kind: 'instant', unit: 'USD', tags: [['us-gaap', 'Assets']] },
  total_liabilities: { label: 'total liabilities', kind: 'instant', unit: 'USD', tags: [['us-gaap', 'Liabilities']] },
  equity: { label: "shareholders' equity", kind: 'instant', unit: 'USD', tags: [['us-gaap', 'StockholdersEquity'], ['us-gaap', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']] },
  cash: { label: 'cash and cash equivalents', kind: 'instant', unit: 'USD', tags: [['us-gaap', 'CashAndCashEquivalentsAtCarryingValue'], ['us-gaap', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents']] },
  long_term_debt: { label: 'long-term debt', kind: 'instant', unit: 'USD', tags: [['us-gaap', 'LongTermDebt'], ['us-gaap', 'LongTermDebtNoncurrent']] },
  shares_outstanding: { label: 'shares outstanding', kind: 'instant', unit: 'shares', tags: [['dei', 'EntityCommonStockSharesOutstanding']], anyForm: true },
};

// Checked in this order, so "operating profit" is not read as "profit".
const METRIC_WORDS = [
  ['shares_outstanding', /shares outstanding|outstanding shares|share count/],
  ['eps', /\beps\b|earnings per share/],
  ['operating_income', /operating (income|profit|earnings)/],
  ['net_income', /net (income|profit|earnings)|\bprofit|bottom line|\bearnings/],
  ['revenue', /revenue|\bsales\b|turnover|top line/],
  ['total_liabilities', /liabilit/],
  ['total_assets', /\bassets\b/],
  ['equity', /equity|book value|net worth/],
  ['cash', /\bcash\b/],
  ['long_term_debt', /\bdebt\b|borrowings/],
];

export function resolveMetric(raw) {
  const text = String(raw ?? '').toLowerCase().replace(/[_-]/g, ' ');
  if (!text.trim()) return null;
  for (const [key, re] of METRIC_WORDS) if (re.test(text)) return key;
  return null;
}

export const resolvePeriod = (raw) => (/\bquarter|quarterly|\bq[1-4]\b/i.test(String(raw ?? '')) ? 'quarter' : 'annual');

const ANNUAL_FORMS = /^(10-K|20-F|40-F)(\/A)?$/;
const QUARTER_FORMS = /^10-Q(\/A)?$/;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

// The newest figure that is a full year (or a full quarter) for flow items, or
// a balance-sheet date for the rest. A 10-K also repeats the two prior years,
// so the newest period end wins, and a later re-filing of the same period wins
// over the original.
export function pickFact(facts, metric, period) {
  const formOk = (f) => (metric.anyForm ? /^(10-K|10-Q|20-F|40-F)/.test(f.form) : (period === 'quarter' ? QUARTER_FORMS : ANNUAL_FORMS).test(f.form));
  const spanOk = (f) => {
    if (metric.kind !== 'flow') return true;
    if (!f.start) return false;
    const span = days(f.start, f.end);
    return period === 'quarter' ? span >= 80 && span <= 100 : span >= 330 && span <= 380;
  };
  const usable = (facts ?? []).filter((f) => Number.isFinite(f?.val) && f.end && formOk(f) && spanOk(f));
  usable.sort((a, b) => (b.end.localeCompare(a.end)) || String(b.filed ?? '').localeCompare(String(a.filed ?? '')));
  return usable[0] ?? null;
}

async function conceptFacts(cik, taxonomy, tag, unit) {
  const url = `${CONCEPT_BASE}/CIK${String(cik).padStart(10, '0')}/${taxonomy}/${tag}.json`;
  const body = await cached(url, CONCEPT_TTL_MS, () => getJson(url, { allow404: true }));
  return body?.units?.[unit] ?? null;
}

// One metric for one company. Companies change which tag they report under
// over the years, so every candidate tag is read and the one with the newest
// period wins.
export async function fetchMetric(company, metricKey, period) {
  const metric = METRICS[metricKey];
  const found = await Promise.all(metric.tags.map(async ([taxonomy, tag]) => {
    const facts = await conceptFacts(company.cik, taxonomy, tag, metric.unit);
    const fact = pickFact(facts, metric, period);
    return fact ? { tag, fact } : null;
  }));
  const best = found.filter(Boolean).sort((a, b) => b.fact.end.localeCompare(a.fact.end))[0];
  if (!best) return null;
  const { fact } = best;
  return {
    metric: metricKey,
    label: metric.label,
    value: fact.val,
    unit: metric.unit,
    period_end: fact.end,
    period_start: fact.start ?? null,
    fiscal_year: fact.fy ?? null,
    fiscal_period: fact.fp ?? null,
    form: fact.form,
    filed: fact.filed ?? null,
    tag: best.tag,
  };
}

export function formatValue(value, unit) {
  if (unit === 'USD/shares') return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)} per share`;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const scaled = (n, word) => `${n.toFixed(2)} ${word}`;
  if (unit === 'shares') return abs >= 1e9 ? `${scaled(abs / 1e9, 'billion')} shares` : abs >= 1e6 ? `${scaled(abs / 1e6, 'million')} shares` : `${abs.toLocaleString('en-US')} shares`;
  if (abs >= 1e9) return `${sign}$${scaled(abs / 1e9, 'billion')}`;
  if (abs >= 1e6) return `${sign}$${scaled(abs / 1e6, 'million')}`;
  return `${sign}$${abs.toLocaleString('en-US')}`;
}
