// MACRO_ECONOMIC_INDICATOR signal, country-level macroeconomic data via the
// World Bank API (no key, no practical rate limit). Chosen over BIS: the
// guessed BIS SDMX paths returned 404/400 when checked live, while World
// Bank's REST API for GDP growth, inflation, and unemployment answers
// cleanly for both ISO codes and full country names once resolved.

const WORLD_BANK_URL = 'https://api.worldbank.org/v2/country';
const REQUEST_TIMEOUT_MS = Number(process.env.MACRO_TIMEOUT_MS) || 8_000;
const CACHE_TTL_MS = Number(process.env.MACRO_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 300;

export const WORLD_BANK_ATTRIBUTION = 'World Bank Open Data (worldbank.org), via its public API.';

export class MacroUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MacroUpstreamError';
  }
}

export class MacroLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MacroLookupError';
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

const dataCache = new TtlCache();

export function __clearMacroCacheForTesting() {
  dataCache.store.clear();
}

// Indicator names people actually type, mapped to World Bank's indicator
// codes. Not exhaustive, just the ones that show up in real questions.
// Found live 2026-09-18: "How fast is the US economy growing?" and "How is
// India's economy growing this year?" both refused, because the substring
// match against "growth" does not match the word "growing" at all (they
// diverge after "grow"), and "economy" alone was too generic to add as its
// own key (it would wrongly match any economic question). "growing" and
// "economy is growing" are added as their own literal entries rather than
// widening the match to bare "economy", which risks false positives on
// unrelated economic questions.
export const INDICATOR_MAP = {
  gdp: 'NY.GDP.MKTP.KD.ZG', 'gdp growth': 'NY.GDP.MKTP.KD.ZG', 'gdp growth rate': 'NY.GDP.MKTP.KD.ZG',
  'economic growth': 'NY.GDP.MKTP.KD.ZG', growth: 'NY.GDP.MKTP.KD.ZG', growing: 'NY.GDP.MKTP.KD.ZG',
  'economy growing': 'NY.GDP.MKTP.KD.ZG', 'economy is growing': 'NY.GDP.MKTP.KD.ZG',
  inflation: 'FP.CPI.TOTL.ZG', 'inflation rate': 'FP.CPI.TOTL.ZG', cpi: 'FP.CPI.TOTL.ZG',
  'consumer price index': 'FP.CPI.TOTL.ZG',
  unemployment: 'SL.UEM.TOTL.ZS', 'unemployment rate': 'SL.UEM.TOTL.ZS', jobless: 'SL.UEM.TOTL.ZS',
};

const INDICATOR_LABELS = {
  'NY.GDP.MKTP.KD.ZG': 'GDP growth',
  'FP.CPI.TOTL.ZG': 'inflation',
  'SL.UEM.TOTL.ZS': 'unemployment',
};

export function resolveIndicatorCode(raw) {
  if (typeof raw !== 'string') return null;
  const bare = raw.trim().toLowerCase();
  if (!bare) return null;
  if (/^[a-z]{2}\.[a-z]{3}\.[a-z0-9]{4}\.[a-z]{2}$/i.test(bare)) return raw.trim().toUpperCase();
  if (INDICATOR_MAP[bare]) return INDICATOR_MAP[bare];
  for (const [name, code] of Object.entries(INDICATOR_MAP)) {
    if (bare.includes(name)) return code;
  }
  return null;
}

export function indicatorLabel(code) {
  return INDICATOR_LABELS[code] ?? code;
}

// Country names people actually type, mapped to ISO 3166-1 alpha-2. Not
// exhaustive, just common cases; a bare 2-3 letter code is passed through.
const COUNTRY_NAME_MAP = {
  'united states': 'US', usa: 'US', us: 'US', america: 'US',
  'united kingdom': 'GB', uk: 'GB', britain: 'GB', england: 'GB',
  china: 'CN', japan: 'JP', germany: 'DE', france: 'FR', italy: 'IT', spain: 'ES',
  canada: 'CA', mexico: 'MX', brazil: 'BR', argentina: 'AR', india: 'IN',
  russia: 'RU', 'south korea': 'KR', korea: 'KR', australia: 'AU', 'new zealand': 'NZ',
  netherlands: 'NL', holland: 'NL', belgium: 'BE', switzerland: 'CH', austria: 'AT',
  sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI', poland: 'PL', turkey: 'TR',
  greece: 'GR', portugal: 'PT', ireland: 'IE', 'south africa': 'ZA', nigeria: 'NG',
  egypt: 'EG', kenya: 'KE', 'saudi arabia': 'SA', uae: 'AE', 'united arab emirates': 'AE',
  israel: 'IL', indonesia: 'ID', malaysia: 'MY', thailand: 'TH', vietnam: 'VN',
  philippines: 'PH', singapore: 'SG', pakistan: 'PK', bangladesh: 'BD',
  colombia: 'CO', chile: 'CL', peru: 'PE', venezuela: 'VE', ukraine: 'UA',
};

export function resolveCountryCode(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare = trimmed.toLowerCase();
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (/^[a-z]{3}$/i.test(trimmed)) return trimmed.toUpperCase();
  if (COUNTRY_NAME_MAP[bare]) return COUNTRY_NAME_MAP[bare];
  for (const [name, code] of Object.entries(COUNTRY_NAME_MAP)) {
    if (bare.includes(name)) return code;
  }
  return null;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    if (err.name === 'AbortError') throw new MacroUpstreamError(`World Bank timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new MacroUpstreamError(`World Bank request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Fetches the most recent non-null value for `countryCode`/`indicatorCode`.
// Returns { country, countryCode, indicator, indicatorCode, year, value } or
// throws MacroLookupError when the World Bank has no data for that pair.
export async function fetchMacroIndicator(countryCode, indicatorCode) {
  if (!countryCode) throw new MacroLookupError('no recognisable country supplied');
  if (!indicatorCode) throw new MacroLookupError('no recognisable indicator supplied (try GDP growth, inflation, or unemployment)');

  const cacheKey = `${countryCode}:${indicatorCode}`;
  const cached = dataCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${WORLD_BANK_URL}/${encodeURIComponent(countryCode)}/indicator/${encodeURIComponent(indicatorCode)}?format=json&per_page=20`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new MacroUpstreamError(`World Bank returned HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new MacroUpstreamError(`World Bank returned unreadable JSON: ${err.message}`);
  }
  const rows = Array.isArray(body?.[1]) ? body[1] : [];
  if (!rows.length) {
    throw new MacroLookupError(`World Bank has no data for country code ${countryCode}; check the country name or ISO code`);
  }
  const withValue = rows.find((r) => r.value !== null && r.value !== undefined);
  if (!withValue) {
    throw new MacroLookupError(`World Bank has no recent published value for ${indicatorLabel(indicatorCode)} in ${rows[0]?.country?.value ?? countryCode}`);
  }
  const result = {
    country: withValue.country?.value ?? countryCode,
    countryCode,
    indicator: indicatorLabel(indicatorCode),
    indicatorCode,
    year: withValue.date,
    value: withValue.value,
    unit: indicatorCode === 'NY.GDP.MKTP.KD.ZG' || indicatorCode === 'FP.CPI.TOTL.ZG' || indicatorCode === 'SL.UEM.TOTL.ZS' ? 'percent' : null,
  };
  dataCache.set(cacheKey, result, CACHE_TTL_MS);
  return result;
}
