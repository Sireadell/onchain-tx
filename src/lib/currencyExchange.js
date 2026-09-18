// CURRENCY_EXCHANGE signal, live foreign exchange rates via Frankfurter
// (ECB reference rates, no key, no practical rate limit). Frankfurter only
// carries ECB's own currency list (major fiat, no crypto, no gold), so a
// symbol outside that list is answered honestly rather than guessed at.

const FRANKFURTER_URL = 'https://api.frankfurter.app';
const REQUEST_TIMEOUT_MS = Number(process.env.CURRENCY_TIMEOUT_MS) || 8_000;
const CACHE_TTL_MS = Number(process.env.CURRENCY_CACHE_TTL_MS) || 5 * 60_000;
const MAX_CACHE_ENTRIES = 300;

// Upstream is down, rate-limited or returned something unreadable. TxLens's
// fault, not the caller's, so the route answers this with a real error code.
export class CurrencyUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CurrencyUpstreamError';
  }
}

// The caller named a currency Frankfurter's ECB feed does not carry, or gave
// no parseable currency at all. The caller's problem, answered as
// invalid_input by the route.
export class CurrencyLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CurrencyLookupError';
  }
}

class TtlCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      this.store.delete(this.store.keys().next().value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

const rateCache = new TtlCache();
const symbolsCache = new TtlCache();

export function __clearCurrencyCacheForTesting() {
  rateCache.store.clear();
  symbolsCache.store.clear();
}

// Plain-English currency names people actually type ("dollars", "euros",
// "pounds") mapped to the ISO 4217 code Frankfurter expects. Not exhaustive,
// just the currencies that show up in real questions.
const CURRENCY_NAME_MAP = {
  dollar: 'USD', dollars: 'USD', usd: 'USD', 'us dollar': 'USD', 'us dollars': 'USD',
  'american dollar': 'USD', 'american dollars': 'USD',
  euro: 'EUR', euros: 'EUR', eur: 'EUR',
  pound: 'GBP', pounds: 'GBP', 'pound sterling': 'GBP', sterling: 'GBP', gbp: 'GBP',
  yen: 'JPY', jpy: 'JPY', 'japanese yen': 'JPY',
  yuan: 'CNY', cny: 'CNY', rmb: 'CNY', renminbi: 'CNY', 'chinese yuan': 'CNY',
  'swiss franc': 'CHF', 'swiss francs': 'CHF', franc: 'CHF', francs: 'CHF', chf: 'CHF',
  'canadian dollar': 'CAD', 'canadian dollars': 'CAD', cad: 'CAD',
  'australian dollar': 'AUD', 'australian dollars': 'AUD', aud: 'AUD',
  'new zealand dollar': 'NZD', nzd: 'NZD',
  rupee: 'INR', rupees: 'INR', inr: 'INR', 'indian rupee': 'INR',
  won: 'KRW', krw: 'KRW', 'korean won': 'KRW',
  rand: 'ZAR', zar: 'ZAR', 'south african rand': 'ZAR',
  real: 'BRL', reais: 'BRL', brl: 'BRL', 'brazilian real': 'BRL',
  peso: 'MXN', pesos: 'MXN', mxn: 'MXN', 'mexican peso': 'MXN',
  krona: 'SEK', kronor: 'SEK', sek: 'SEK', 'swedish krona': 'SEK',
  krone: 'NOK', kroner: 'NOK', nok: 'NOK', 'norwegian krone': 'NOK',
  zloty: 'PLN', pln: 'PLN', 'polish zloty': 'PLN',
  lira: 'TRY', try: 'TRY', 'turkish lira': 'TRY',
  shekel: 'ILS', shekels: 'ILS', ils: 'ILS',
  ringgit: 'MYR', myr: 'MYR',
  baht: 'THB', thb: 'THB',
  rupiah: 'IDR', idr: 'IDR',
  'hong kong dollar': 'HKD', hkd: 'HKD',
  'singapore dollar': 'SGD', sgd: 'SGD',
  koruna: 'CZK', czk: 'CZK',
  forint: 'HUF', huf: 'HUF',
  'danish krone': 'DKK', dkk: 'DKK',
  // Found live 2026-09-17: "british pound(s)" (the adjective-prefixed form
  // people actually type) had no mapping at all, and "naira" had none
  // either. Naira is not on Frankfurter's ECB list (checked live: 30
  // currencies, no NGN), so this still ends in an honest refusal, but one
  // that names Nigerian Naira specifically instead of a generic "no
  // currency found" message.
  'british pound': 'GBP', 'british pounds': 'GBP',
  naira: 'NGN', ngn: 'NGN', 'nigerian naira': 'NGN',
};

// Currencies Frankfurter's ECB feed actually carries, used to reject a
// well-formed-but-unsupported code (e.g. a cryptocurrency ticker) honestly
// instead of letting a bad request through to the API and reporting its
// error as if it were a data problem. Fetched once and cached; falls back to
// this static list (Frankfurter's currency set is effectively fixed) if the
// live /currencies endpoint cannot be reached.
const KNOWN_SYMBOLS = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD', 'NZD', 'INR', 'KRW',
  'ZAR', 'BRL', 'MXN', 'SEK', 'NOK', 'DKK', 'PLN', 'TRY', 'ILS', 'MYR', 'THB',
  'IDR', 'HKD', 'SGD', 'CZK', 'HUF', 'BGN', 'RON', 'HRK', 'ISK', 'PHP',
]);

// Resolves a currency name or code to an ISO 4217 code, or null when
// nothing recognisable was supplied.
export function resolveCurrencyCode(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare = trimmed.replace(/[.,]/g, '').toLowerCase();
  if (/^[a-z]{3}$/.test(bare)) return bare.toUpperCase();
  if (CURRENCY_NAME_MAP[bare]) return CURRENCY_NAME_MAP[bare];
  // A phrase containing a known name, e.g. "in US dollars please".
  for (const [name, code] of Object.entries(CURRENCY_NAME_MAP)) {
    if (name.length >= 3 && bare.includes(name)) return code;
  }
  // A bare 3-letter code sitting inside a longer string ("convert to usd now").
  const codeMatch = trimmed.match(/\b([A-Za-z]{3})\b/);
  if (codeMatch) return codeMatch[1].toUpperCase();
  return null;
}

export function isKnownCurrency(code) {
  return KNOWN_SYMBOLS.has(String(code ?? '').toUpperCase());
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    if (err.name === 'AbortError') throw new CurrencyUpstreamError(`Frankfurter timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new CurrencyUpstreamError(`Frankfurter request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Converts `amount` of `from` into `to`, both ISO 4217 codes. Throws
// CurrencyLookupError for an unsupported code and CurrencyUpstreamError when
// Frankfurter itself cannot answer.
export async function convertCurrency(from, to, amount = 1) {
  const fromCode = String(from ?? '').toUpperCase();
  const toCode = String(to ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(fromCode)) throw new CurrencyLookupError(`'${from}' is not a recognisable currency code`);
  if (!/^[A-Z]{3}$/.test(toCode)) throw new CurrencyLookupError(`'${to}' is not a recognisable currency code`);
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 0) {
    throw new CurrencyLookupError(`'${amount}' is not a usable amount`);
  }

  if (fromCode === toCode) {
    return {
      from: fromCode, to: toCode, amount: numericAmount, rate: 1, result: numericAmount,
      date: new Date().toISOString().slice(0, 10), source: 'identity', fetchedAt: new Date().toISOString(),
    };
  }

  const cacheKey = `${fromCode}:${toCode}`;
  let cached = rateCache.get(cacheKey);
  if (cached === undefined) {
    const url = `${FRANKFURTER_URL}/latest?from=${encodeURIComponent(fromCode)}&to=${encodeURIComponent(toCode)}`;
    const res = await fetchWithTimeout(url);
    if (res.status === 404) {
      throw new CurrencyLookupError(`Frankfurter does not have exchange rate data for ${fromCode} or ${toCode}`);
    }
    if (!res.ok) throw new CurrencyUpstreamError(`Frankfurter returned HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch (err) {
      throw new CurrencyUpstreamError(`Frankfurter returned unreadable JSON: ${err.message}`);
    }
    const rate = body?.rates?.[toCode];
    if (!Number.isFinite(rate)) {
      throw new CurrencyLookupError(`Frankfurter does not publish a rate from ${fromCode} to ${toCode}`);
    }
    cached = { rate, date: body.date ?? new Date().toISOString().slice(0, 10) };
    rateCache.set(cacheKey, cached, CACHE_TTL_MS);
  }

  return {
    from: fromCode,
    to: toCode,
    amount: numericAmount,
    rate: cached.rate,
    result: Number((numericAmount * cached.rate).toFixed(6)),
    date: cached.date,
    source: 'Frankfurter (ECB reference rates)',
    fetchedAt: new Date().toISOString(),
  };
}
