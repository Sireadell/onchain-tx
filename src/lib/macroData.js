// MACRO_ECONOMIC_INDICATOR signal, country-level macroeconomic data via the
// World Bank API (no key, no practical rate limit). Chosen over BIS: the
// guessed BIS SDMX paths returned 404/400 when checked live, while World
// Bank's REST API for GDP growth, inflation, and unemployment answers
// cleanly for both ISO codes and full country names once resolved.

const WORLD_BANK_URL = 'https://api.worldbank.org/v2/country';
const REQUEST_TIMEOUT_MS = Number(process.env.MACRO_TIMEOUT_MS) || 5_000;
const IMF_URL = 'https://www.imf.org/external/datamapper/api/v1';
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
  lastGood?.clear?.();
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
  'gdp per capita': 'NY.GDP.PCAP.CD', 'income per person': 'NY.GDP.PCAP.CD',
  'nominal gdp': 'NY.GDP.MKTP.CD', 'gdp in dollars': 'NY.GDP.MKTP.CD', 'size of the economy': 'NY.GDP.MKTP.CD',
  population: 'SP.POP.TOTL',
  'government debt': 'GC.DOD.TOTL.GD.ZS', 'public debt': 'GC.DOD.TOTL.GD.ZS', 'debt to gdp': 'GC.DOD.TOTL.GD.ZS', 'debt-to-gdp': 'GC.DOD.TOTL.GD.ZS',
  'current account': 'BN.CAB.XOKA.GD.ZS',
};

// Longest names first, so "gdp per capita" is matched before "gdp".
const INDICATOR_NAMES_BY_LENGTH = Object.keys(INDICATOR_MAP).sort((a, b) => b.length - a.length);

const INDICATOR_LABELS = {
  'NY.GDP.MKTP.KD.ZG': 'GDP growth',
  'FP.CPI.TOTL.ZG': 'inflation',
  'SL.UEM.TOTL.ZS': 'unemployment',
  'NY.GDP.PCAP.CD': 'GDP per capita',
  'NY.GDP.MKTP.CD': 'GDP',
  'SP.POP.TOTL': 'population',
  'GC.DOD.TOTL.GD.ZS': 'central government debt',
  'BN.CAB.XOKA.GD.ZS': 'current account balance',
};

const INDICATOR_UNITS = {
  'NY.GDP.MKTP.KD.ZG': 'percent', 'FP.CPI.TOTL.ZG': 'percent', 'SL.UEM.TOTL.ZS': 'percent',
  'GC.DOD.TOTL.GD.ZS': 'percent of GDP', 'BN.CAB.XOKA.GD.ZS': 'percent of GDP',
  'NY.GDP.PCAP.CD': 'current US dollars', 'NY.GDP.MKTP.CD': 'current US dollars', 'SP.POP.TOTL': 'people',
};

// The same series in the IMF World Economic Outlook (DataMapper API, no key).
// Used when the World Bank API is slow or down: found live 2026-11-12, three
// scored questions in a row timed out on the World Bank at 8s and scored 0.
const IMF_CODES = {
  'NY.GDP.MKTP.KD.ZG': 'NGDP_RPCH', 'FP.CPI.TOTL.ZG': 'PCPIPCH', 'SL.UEM.TOTL.ZS': 'LUR',
  'NY.GDP.PCAP.CD': 'NGDPDPC', 'GC.DOD.TOTL.GD.ZS': 'GGXWDG_NGDP', 'BN.CAB.XOKA.GD.ZS': 'BCA_NGDPD',
};

export function indicatorUnit(code) {
  return INDICATOR_UNITS[code] ?? null;
}

export function resolveIndicatorCode(raw) {
  if (typeof raw !== 'string') return null;
  const bare = raw.trim().toLowerCase();
  if (!bare) return null;
  if (/^[a-z]{2}\.[a-z]{3}\.[a-z0-9]{4}\.[a-z]{2}$/i.test(bare)) return raw.trim().toUpperCase();
  if (INDICATOR_MAP[bare]) return INDICATOR_MAP[bare];
  for (const name of INDICATOR_NAMES_BY_LENGTH) {
    if (bare.includes(name)) return INDICATOR_MAP[name];
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

const ISO3 = {
  US: 'USA', GB: 'GBR', CN: 'CHN', JP: 'JPN', DE: 'DEU', FR: 'FRA', IT: 'ITA', ES: 'ESP', CA: 'CAN', MX: 'MEX',
  BR: 'BRA', AR: 'ARG', IN: 'IND', RU: 'RUS', KR: 'KOR', AU: 'AUS', NZ: 'NZL', NL: 'NLD', BE: 'BEL', CH: 'CHE',
  AT: 'AUT', SE: 'SWE', NO: 'NOR', DK: 'DNK', FI: 'FIN', PL: 'POL', TR: 'TUR', GR: 'GRC', PT: 'PRT', IE: 'IRL',
  ZA: 'ZAF', NG: 'NGA', EG: 'EGY', KE: 'KEN', SA: 'SAU', AE: 'ARE', IL: 'ISR', ID: 'IDN', MY: 'MYS', TH: 'THA',
  VN: 'VNM', PH: 'PHL', SG: 'SGP', PK: 'PAK', BD: 'BGD', CO: 'COL', CL: 'CHL', PE: 'PER', VE: 'VEN', UA: 'UKR',
};

const COUNTRY_NAMES = {
  US: 'United States', GB: 'United Kingdom', CN: 'China', JP: 'Japan', DE: 'Germany', FR: 'France', IT: 'Italy',
  ES: 'Spain', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', IN: 'India', RU: 'Russia',
  KR: 'South Korea', AU: 'Australia', NZ: 'New Zealand', NL: 'Netherlands', TR: 'Turkey', ZA: 'South Africa',
  NG: 'Nigeria', SA: 'Saudi Arabia', ID: 'Indonesia', CH: 'Switzerland', SE: 'Sweden', PL: 'Poland',
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

function fetchWorldBank(countryCode, indicatorCode) {
  const url = `${WORLD_BANK_URL}/${encodeURIComponent(countryCode)}/indicator/${encodeURIComponent(indicatorCode)}?format=json&per_page=20`;
  return (async () => {
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
    const valued = rows.filter((r) => r.value !== null && r.value !== undefined);
    if (!valued.length) {
      throw new MacroLookupError(`World Bank has no recent published value for ${indicatorLabel(indicatorCode)} in ${rows[0]?.country?.value ?? countryCode}`);
    }
    const latest = valued[0];
    return {
      country: latest.country?.value ?? countryCode,
      countryCode,
      indicator: indicatorLabel(indicatorCode),
      indicatorCode,
      year: latest.date,
      value: latest.value,
      unit: indicatorUnit(indicatorCode),
      history: valued.slice(0, 6).map((r) => ({ year: r.date, value: r.value })),
      source: 'World Bank',
      sourceUrl: url,
    };
  })();
}

async function fetchImf(countryCode, indicatorCode) {
  const imfCode = IMF_CODES[indicatorCode];
  const iso3 = countryCode.length === 3 ? countryCode : ISO3[countryCode];
  if (!imfCode || !iso3) throw new MacroUpstreamError('no IMF series for this pair');
  const url = `${IMF_URL}/${imfCode}/${iso3}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new MacroUpstreamError(`IMF returned HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  const series = body?.values?.[imfCode]?.[iso3];
  if (!series || typeof series !== 'object') throw new MacroUpstreamError('IMF has no series for this pair');
  // The IMF series carries projections for future years. Only years up to the
  // last completed one are reported as the latest figure.
  const lastYear = new Date().getUTCFullYear() - 1;
  const years = Object.keys(series).filter((y) => Number(y) <= lastYear && Number.isFinite(series[y])).sort().reverse();
  if (!years.length) throw new MacroUpstreamError('IMF has no recent value for this pair');
  const next = String(lastYear + 1);
  return {
    country: COUNTRY_NAMES[countryCode] ?? countryCode,
    countryCode,
    indicator: indicatorLabel(indicatorCode),
    indicatorCode,
    year: years[0],
    value: series[years[0]],
    unit: indicatorUnit(indicatorCode),
    history: years.slice(0, 6).map((y) => ({ year: y, value: series[y] })),
    projection: Number.isFinite(series[next]) ? { year: next, value: series[next] } : null,
    source: 'IMF World Economic Outlook',
    sourceUrl: url,
  };
}

// Last good answer per pair, kept past the cache lifetime. Annual series
// change once a year, so a figure read a day ago is still the published one
// when both live sources are down.
const lastGood = new Map();

// Fetches the most recent non-null value for `countryCode`/`indicatorCode`.
// World Bank first; the IMF answers when the World Bank is slow or down, and
// the last good reading answers when both are. Throws MacroLookupError when
// the pair has no data at all.
export async function fetchMacroIndicator(countryCode, indicatorCode) {
  if (!countryCode) throw new MacroLookupError('no recognisable country supplied');
  if (!indicatorCode) throw new MacroLookupError('no recognisable indicator supplied (try GDP growth, inflation, or unemployment)');

  const cacheKey = `${countryCode}:${indicatorCode}`;
  const cached = dataCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Race the two sources. The World Bank API is often slow from here (a
  // plain curl timed out at 20s on 2026-11-12) while the IMF answers in about
  // 2s, so whichever answers first is used; when the IMF is first, the World
  // Bank gets a short grace period because it is the preferred source.
  const wb = fetchWorldBank(countryCode, indicatorCode);
  const imf = fetchImf(countryCode, indicatorCode);
  wb.catch(() => {});
  imf.catch(() => {});
  const wbSettled = wb.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  const imfSettled = imf.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  let result = null;
  const first = await Promise.race([
    wbSettled.then((r) => ({ from: 'wb', r })),
    imfSettled.then((r) => ({ from: 'imf', r })),
  ]);
  if (first.r.ok) {
    result = first.r.value;
    if (first.from === 'imf') {
      const grace = await Promise.race([wbSettled, new Promise((resolve) => setTimeout(() => resolve(null), 1_200))]);
      if (grace?.ok) result = grace.value;
    }
  } else {
    const [wbRes, imfRes] = await Promise.all([wbSettled, imfSettled]);
    if (wbRes.ok) result = wbRes.value;
    else if (imfRes.ok) result = imfRes.value;
    if (!result) {
      if (lastGood.has(cacheKey)) return { ...lastGood.get(cacheKey), stale: true };
      throw wbRes.error;
    }
  }
  dataCache.set(cacheKey, result, CACHE_TTL_MS);
  if (lastGood.size >= MAX_CACHE_ENTRIES && !lastGood.has(cacheKey)) lastGood.delete(lastGood.keys().next().value);
  lastGood.set(cacheKey, result);
  return result;
}

// Fills the cache for the countries and indicators people ask about most, in
// the background, so a scored question lands on a ready answer instead of
// waiting for a slow statistics API.
const PREWARM_COUNTRIES = ['US', 'GB', 'DE', 'JP', 'CN', 'FR', 'IN', 'CA', 'BR', 'AU', 'IT', 'ES', 'MX', 'KR', 'RU', 'ZA', 'NG', 'TR', 'AR', 'ID', 'CH', 'SE', 'NL', 'PL', 'SA'];
const PREWARM_INDICATORS = ['FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS', 'NY.GDP.MKTP.KD.ZG', 'NY.GDP.PCAP.CD'];

export async function prewarmMacroCache() {
  const jobs = [];
  for (const indicator of PREWARM_INDICATORS) for (const country of PREWARM_COUNTRIES) jobs.push([country, indicator]);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [country, indicator] = jobs[next++];
      try { await fetchMacroIndicator(country, indicator); } catch { /* a miss is retried on the next cycle */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
