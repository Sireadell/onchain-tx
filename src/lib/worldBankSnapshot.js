// A stored copy of the World Bank World Development Indicators series this
// miner answers from (1980 to 2025, every country, CC BY 4.0), so a question
// about a named year is answered at once from the published figure, even when
// the live World Bank API is slow (16 s for one value on 2026-11-24) or down.
// Refresh by re-downloading /v2/country/all/indicator/<code>?date=1980:2025.

import snapshot from '../data/worldBankSnapshot.json' with { type: 'json' };

export const SNAPSHOT_DATE = snapshot.generated;

const COUNTRIES = snapshot.countries.map(([iso2, iso3, name]) => ({ iso2, iso3, name }));
const BY_ISO2 = new Map(COUNTRIES.map((c) => [c.iso2, c]));
const BY_ISO3 = new Map(COUNTRIES.map((c) => [c.iso3, c]));

// Short names and common spellings people type that differ from the World
// Bank's official country names.
const ALIASES = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US',
  'united kingdom': 'GB', uk: 'GB', 'u.k.': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB',
  russia: 'RU', 'south korea': 'KR', korea: 'KR', 'north korea': 'KP', iran: 'IR', egypt: 'EG',
  syria: 'SY', venezuela: 'VE', yemen: 'YE', vietnam: 'VN', 'viet nam': 'VN', laos: 'LA', 'lao pdr': 'LA',
  turkey: 'TR', turkiye: 'TR', 'türkiye': 'TR', slovakia: 'SK', 'czech republic': 'CZ', czechia: 'CZ',
  kyrgyzstan: 'KG', gambia: 'GM', 'the gambia': 'GM', bahamas: 'BS', 'the bahamas': 'BS',
  'ivory coast': 'CI', "cote d'ivoire": 'CI', 'côte d’ivoire': 'CI', "côte d'ivoire": 'CI',
  'congo dr': 'CD', 'dr congo': 'CD', 'democratic republic of the congo': 'CD', 'democratic republic of congo': 'CD',
  'republic of the congo': 'CG', 'congo republic': 'CG', 'congo-brazzaville': 'CG',
  'hong kong': 'HK', macau: 'MO', macao: 'MO', 'cape verde': 'CV', micronesia: 'FM',
  'st. lucia': 'LC', 'saint lucia': 'LC', 'st. kitts and nevis': 'KN', 'saint kitts and nevis': 'KN',
  'st. vincent and the grenadines': 'VC', 'saint vincent and the grenadines': 'VC',
  holland: 'NL', 'the netherlands': 'NL', burma: 'MM', swaziland: 'SZ', 'east timor': 'TL',
  palestine: 'PS', 'west bank and gaza': 'PS', brunei: 'BN', uae: 'AE', 'emirates': 'AE',
  'sao tome and principe': 'ST', 'são tomé and príncipe': 'ST', 'north macedonia': 'MK', macedonia: 'MK',
  'bosnia': 'BA', 'bosnia and herzegovina': 'BA', taiwan: null,
};

function normalise(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'");
}

// Every name to look for, longest first, so "south sudan" wins over "sudan"
// and "niger" does not swallow "nigeria".
const NAME_INDEX = (() => {
  const entries = [];
  for (const c of COUNTRIES) {
    const official = normalise(c.name);
    entries.push([official, c.iso2]);
    // "Egypt, Arab Rep." -> "egypt"; "Korea, Rep." -> "korea, rep."; keep the
    // part before the comma as an alias when it is unambiguous.
    const head = official.split(',')[0].trim();
    if (head !== official && head.length > 3) entries.push([head, c.iso2]);
  }
  for (const [name, iso2] of Object.entries(ALIASES)) if (iso2) entries.push([normalise(name), iso2]);
  const seen = new Map();
  for (const [name, iso2] of entries) if (!seen.has(name)) seen.set(name, iso2);
  return [...seen.entries()].sort((a, b) => b[0].length - a[0].length);
})();

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const NAME_RES = NAME_INDEX.map(([name, iso2]) => [new RegExp(`(^|[^a-z])${escapeRe(name)}('s)?(?=$|[^a-z])`), iso2]);

// Finds the country a sentence is about. Whole-word matches only, so "the"
// is never read as a country code and "Russia" never as "us". A bare upper
// case "US" or "UK" in the original text counts too.
export function findCountry(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const raw = text.trim();
  if (/^[A-Za-z]{2}$/.test(raw) && BY_ISO2.has(raw.toUpperCase())) return raw.toUpperCase();
  if (/^[A-Za-z]{3}$/.test(raw) && BY_ISO3.has(raw.toUpperCase())) return BY_ISO3.get(raw.toUpperCase()).iso2;
  const t = normalise(raw);
  for (const [re, iso2] of NAME_RES) if (re.test(t)) return iso2;
  if (/(^|[^A-Za-z])(US|U\.S\.)(?=$|[^A-Za-z])/.test(raw)) return 'US';
  if (/(^|[^A-Za-z])UK(?=$|[^A-Za-z])/.test(raw)) return 'GB';
  return null;
}

// Everyday names for the World Bank's formal ones ("Korea, Rep.").
const DISPLAY = {
  KR: 'South Korea', KP: 'North Korea', RU: 'Russia', EG: 'Egypt', IR: 'Iran', VE: 'Venezuela', YE: 'Yemen',
  SY: 'Syria', LA: 'Laos', CD: 'DR Congo', CG: 'Republic of the Congo', GM: 'The Gambia', BS: 'The Bahamas',
  HK: 'Hong Kong', MO: 'Macao', FM: 'Micronesia', KG: 'Kyrgyzstan', SK: 'Slovakia', VN: 'Vietnam', TR: 'Turkiye',
};

export function countryName(iso2) {
  return DISPLAY[iso2] ?? BY_ISO2.get(iso2)?.name ?? iso2;
}

export function iso3Of(iso2) {
  return BY_ISO2.get(iso2)?.iso3 ?? null;
}

// The published value for one country, series and year, or null.
export function snapshotValue(iso2, indicatorCode, year) {
  const v = snapshot.series[indicatorCode]?.[iso2]?.[String(year)];
  return Number.isFinite(v) ? v : null;
}

// Every published year for one country and series, newest first.
export function snapshotSeries(iso2, indicatorCode) {
  const s = snapshot.series[indicatorCode]?.[iso2];
  if (!s) return [];
  return Object.keys(s).sort().reverse().map((year) => ({ year, value: s[year] }));
}

export function hasSeries(indicatorCode) {
  return Boolean(snapshot.series[indicatorCode]);
}
