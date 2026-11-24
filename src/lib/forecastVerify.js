// WEATHER_FORECAST_VERIFY: reads a past forecast claim out of a plain
// question (place or weather station, target date, predicted high, low or
// rain, the tolerance rule, any reference values the asker quotes), checks it
// against what was observed, and says verified, partly verified or not
// verified first, then the observed figure and the error.
//
// Found in scored rounds 36 to 46 (2026-11-21 to 11-24): we answered every
// such question with a plain "the temperature ranged from X to Y" and never
// compared it with the forecast, refused dates written in words ("24
// September 2026"), and could not read station questions (GHCN USW00024229),
// scoring 0 in 6 of 8 rounds while the top miner states the verdict.
//
// Sources: NOAA NCEI GHCN-Daily for a named station (free, no key), and the
// Open-Meteo ERA5 archive otherwise, the reanalysis the scorer's own questions
// quote as the reference.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

function monthIndex(word) {
  const w = word.toLowerCase().replace('.', '');
  return MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
}
const pad = (n) => String(n).padStart(2, '0');

// Every calendar date in the text, in YYYY-MM-DD form.
export function datesIn(text) {
  const out = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) out.push(`${m[1]}-${pad(m[2])}-${pad(m[3])}`);
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE},?\\s+(\\d{4})\\b`, 'gi'))) {
    out.push(`${m[3]}-${pad(monthIndex(m[2]) + 1)}-${pad(m[1])}`);
  }
  for (const m of s.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) {
    out.push(`${m[3]}-${pad(monthIndex(m[1]) + 1)}-${pad(m[2])}`);
  }
  return out.filter((d) => !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()));
}

// The day being verified: the latest date named. A forecast is always for the
// same day as, or a day after, the day it was issued, so the issue date and
// the run date never win over the target.
export function targetDate(text) {
  const all = datesIn(text);
  return all.length ? all.sort().at(-1) : null;
}

// Big US airports by ICAO code and name, mapped to their NOAA GHCN-Daily
// station (each id checked against NOAA on 2026-11-24). Found 2026-11-23:
// "the actual weather at John F. Kennedy International Airport" was geocoded
// to a town in Utah.
const AIRPORT_STATIONS = [
  ['KJFK', /\b(?:JFK|John F\.? Kennedy)\b/i, 'USW00094789'], ['KLGA', /\bLa\s?Guardia\b/i, 'USW00014732'],
  ['KEWR', /\bNewark\b.*\bairport\b|\bairport\b.*\bNewark\b/i, 'USW00014734'], ['KORD', /\bO'?Hare\b/i, 'USW00094846'],
  ['KLAX', /\bLos Angeles International\b|\bLAX\b/, 'USW00023174'], ['KSFO', /\bSan Francisco International\b|\bSFO\b/, 'USW00023234'],
  ['KATL', /\bHartsfield\b/i, 'USW00013874'], ['KDFW', /\bDFW\b|\bDallas[/ -]Fort Worth\b.*\bairport\b/i, 'USW00003927'],
  ['KDEN', /\bDenver International\b/i, 'USW00003017'], ['KSEA', /\bSea-?Tac\b|\bSeattle[- ]Tacoma\b/i, 'USW00024233'],
  ['KBOS', /\bLogan\b.*\bairport\b|\bBoston Logan\b/i, 'USW00014739'], ['KMIA', /\bMiami International\b/i, 'USW00012839'],
  ['KPHX', /\bSky Harbor\b/i, 'USW00023183'], ['KIAH', /\bBush Intercontinental\b|\bHouston Intercontinental\b/i, 'USW00012960'],
  ['KDCA', /\bReagan National\b/i, 'USW00013743'], ['KBWI', /\bBWI\b|\bBaltimore[- ]Washington\b/i, 'USW00093721'],
  ['KMSP', /\bMinneapolis[- ]St\.? Paul International\b/i, 'USW00014922'], ['KDTW', /\bDetroit Metro/i, 'USW00094847'],
  ['KSAN', /\bSan Diego International\b|\bLindbergh Field\b/i, 'USW00023188'], ['KPDX', /\bPortland International\b|\bPORTLAND INTL\b/i, 'USW00024229'],
];

export function ghcnStation(text) {
  const s = String(text ?? '');
  const m = s.match(/\b([A-Z]{2}[A-Z0-9]\d{8})\b/);
  if (m) return m[1];
  for (const [icao, re, id] of AIRPORT_STATIONS) {
    if (new RegExp(`\\b${icao}\\b`).test(s) || re.test(s)) return id;
  }
  return null;
}

const STOP = new Set(['site-by-site', 'claims', 'our', 'did', 'verify', 'the', 'a', 'an', 'on', 'check', 'before', 'how', 'what', 'count',
  'rule', 'recorded', 'for', 'tolerance', 'do', 'give', 'state', 'use', 'assess', 'reconcile', 'call', 'all', 'era5', 'open-meteo', 'utc',
  'gfs', 'mos', 'nam', 'ghcn', 'tmax', 'tmin', 'tavg', 'celsius', 'fahrenheit', 'c', 'f', 'verified', 'reality', 'observations', 'it',
  'given', 'find', 'was', 'is', 'were', 'i', 'we', 'this', 'that', 'in', 'at', 'near', 'yes', 'no', 'mm', 'tell', 'please', 'quick',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'reanalysis', 'historical', 'archive', 'forecast', 'a1',
  ...MONTHS, 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);
const WORD = "[A-Z][\\p{L}.'’-]*";
const PHRASE = `${WORD}(?:\\s+(?:${WORD}|of|de|da|del|la|el))*`;

// The place a question names, as a short string a geocoder understands.
export function placeIn(text) {
  const s = String(text ?? '').replace(/\([^)]*\)/g, ' ');
  const re = new RegExp(`(${PHRASE})(?:,\\s*(${PHRASE}))?`, 'gu');
  for (const m of s.matchAll(re)) {
    let words = m[1].split(/\s+/);
    while (words.length && STOP.has(words[0].toLowerCase().replace(/[.,:]$/, ''))) words = words.slice(1);
    while (words.length && STOP.has(words.at(-1).toLowerCase().replace(/[.,:]$/, ''))) words = words.slice(0, -1);
    if (!words.length) continue;
    const head = words.join(' ').replace(/[.:]$/, '');
    if (/^\d/.test(head) || head.length < 3) continue;
    let region = m[2] && !STOP.has(m[2].split(/\s+/)[0].toLowerCase()) ? m[2].replace(/[.:]$/, '') : null;
    if (region && datesIn(region).length) region = null;
    // "John F. Kennedy International Airport, New York": geocoders know the
    // city, not the airport name.
    if (/\b(airport|intl|international)\b/i.test(head) && region) return region;
    return region ? `${head}, ${region}` : head;
  }
  return null;
}

const toC = (f) => (f - 32) * 5 / 9;
const round1 = (n) => Math.round(n * 10) / 10;

function kindBefore(text, idx) {
  const before = text.slice(Math.max(0, idx - 70), idx).toLowerCase();
  const hi = Math.max(...['high', 'max', 'maximum', 'highest', 'hot', 'tmax', 'daytime'].map((w) => before.lastIndexOf(w)));
  const lo = Math.max(...['low', 'min', 'minimum', 'lowest', 'overnight', 'tmin', 'cold'].map((w) => before.lastIndexOf(w)));
  if (hi < 0 && lo < 0) return 'max';
  return lo > hi ? 'min' : 'max';
}

// Reads the predicted quantities and any reference observations the asker
// supplied. Temperatures come back in Celsius, rain in millimetres.
export function readClaims(text) {
  const s = String(text ?? '').replace(/−/g, '-');
  // The reference part ("For reference, ERA5 ... gives max temperature 33.1
  // °C", "Recorded values for ...: min temperature 10.0 °C") runs to the
  // next "Rule" or the end; numbers in it are observations, not forecasts.
  const refStart = s.search(/\b(for reference|recorded values|reference values|observed values)\b/i);
  const refEnd = refStart >= 0 ? (() => { const r = s.slice(refStart).search(/\brule\b|\btolerance\b|\bcount it\b/i); return r >= 0 ? refStart + r : s.length; })() : -1;
  const forecast = {}; const reference = {}; let fahrenheit = false;
  const re = /(-?\d+(?:\.\d+)?)\s*(°\s*[CF]\b|degrees?\s+(?:fahrenheit|celsius|f|c)\b|[CF]\b|mm\b|millimet(?:er|re)s?\b|in\b|inch(?:es)?\b)/gi;
  for (const m of s.matchAll(re)) {
    const idx = m.index;
    const pre = s.slice(Math.max(0, idx - 14), idx).toLowerCase();
    // Tolerances, not quantities: "within ±2 °C", "within 2.0 °C", "or 1 mm", "larger of 2 mm".
    if (/±\s*$|within\s*$|or\s*$|allows?\s*$|by\s*$|\+\/-\s*$/.test(pre)) continue;
    if (/larger of|whichever|than\s*$/.test(s.slice(Math.max(0, idx - 22), idx).toLowerCase())) continue;
    const unit = m[2].toLowerCase();
    let v = Number(m[1]); let kind;
    if (/^(mm|millimet)/.test(unit)) kind = 'precip';
    else if (/^(in|inch)/.test(unit)) {
      // "in" is also a word; only a number right before "in" followed by rain words counts.
      if (unit === 'in' && !/\b(rain|precip|precipitation|snow)/i.test(s.slice(idx, idx + 40)) && !/\b(rain|precip)/i.test(s.slice(Math.max(0, idx - 90), idx))) continue;
      kind = 'precip'; v *= 25.4;
    } else {
      kind = kindBefore(s, idx);
      if (/°\s*f|degrees?\s+(fahrenheit|f)\b|^f$/i.test(unit)) { v = toC(v); fahrenheit = true; }
    }
    const into = refStart >= 0 && idx >= refStart && idx < refEnd ? reference : forecast;
    if (into[kind] === undefined) into[kind] = v;
  }
  // "rain 0 mm" and "0 mm of rain" both land above; "no rain" forecast:
  if (forecast.precip === undefined && /\b(no rain|dry day|zero rain)\b/i.test(s)) forecast.precip = 0;
  return { forecast, reference, fahrenheit };
}

export function readTolerance(text) {
  const s = String(text ?? '').toLowerCase();
  const t = s.match(/(?:within|±|\+\/-)\s*±?\s*(\d+(?:\.\d+)?)\s*(?:°\s*)?(c|f|degrees?)/);
  let temp = 2;
  if (t) temp = /f/.test(t[2]) ? Number(t[1]) * 5 / 9 : Number(t[1]);
  let precip = { rule: 'wetdry' };
  const pct = s.match(/(\d+(?:\.\d+)?)\s*%\s*of the forecast\s*or\s*(\d+(?:\.\d+)?)\s*mm/);
  if (pct) precip = { rule: 'pct', pct: Number(pct[1]) / 100, floor: Number(pct[2]) };
  return { temp, precip };
}

function held(kind, fc, obs, tol) {
  if (kind === 'precip') {
    if (tol.precip.rule === 'pct') {
      const allow = Math.max(tol.precip.pct * fc, tol.precip.floor);
      return { ok: Math.abs(obs - fc) <= allow, allow: `${round1(allow)} mm` };
    }
    const bothDry = fc < 1 && obs < 1;
    const bothWet = fc >= 1 && obs >= 1;
    const allow = Math.max(2, obs / 2);
    return { ok: bothDry || (bothWet && Math.abs(obs - fc) <= allow), allow: 'both under 1 mm, or both wet and within the larger of 2 mm and half the observed amount' };
  }
  return { ok: Math.abs(obs - fc) <= tol.temp + 1e-9, allow: `±${round1(tol.temp)} °C` };
}

async function fetchJson(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function ghcnDay(station, date) {
  const url = `https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries&stations=${station}&startDate=${date}&endDate=${date}&dataTypes=TMAX,TMIN,PRCP&units=metric&format=json`;
  const rows = await fetchJson(url);
  const r = rows?.[0];
  if (!r) return null;
  const num = (v) => (v === undefined || v === '' ? null : Number(v));
  return { max: num(r.TMAX), min: num(r.TMIN), precip: num(r.PRCP), source: `NOAA NCEI GHCN-Daily station ${station}` };
}

export async function era5Day(latitude, longitude, date) {
  const q = (models) => `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&start_date=${date}&end_date=${date}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum${models ? `&models=${models}` : ''}&timezone=auto`;
  let body;
  try {
    body = await fetchJson(q('era5'));
  } catch {
    body = await fetchJson(q(null));
  }
  const d = body?.daily;
  if (!d?.time?.length || d.temperature_2m_max?.[0] == null) {
    // ERA5 runs about five days behind; the default archive mix fills the gap.
    body = await fetchJson(q(null));
  }
  const dd = body.daily;
  return {
    max: dd.temperature_2m_max?.[0] ?? null, min: dd.temperature_2m_min?.[0] ?? null, precip: dd.precipitation_sum?.[0] ?? null,
    source: 'Open-Meteo historical archive (ERA5 reanalysis)',
  };
}

const LABEL = { max: 'high', min: 'low', precip: 'precipitation' };
const fmt = (kind, v, fahrenheit) => (kind === 'precip'
  ? `${round1(v)} mm`
  : `${round1(v)} °C${fahrenheit ? ` (${Math.round(v * 9 / 5 + 32)} °F)` : ''}`);

// Builds the reply. `observed` is { max, min, precip, source }.
export function verdictAnswer({ placeName, date, claims, tolerance, observed }) {
  const checks = [];
  for (const kind of ['max', 'min', 'precip']) {
    const fc = claims.forecast[kind];
    if (fc === undefined) continue;
    const ref = claims.reference[kind];
    const obs = ref !== undefined ? ref : observed?.[kind];
    if (obs == null) continue;
    const h = held(kind, fc, obs, tolerance);
    checks.push({ kind, forecast: fc, observed: obs, error: obs - fc, held: h.ok, allow: h.allow, from_reference: ref !== undefined });
  }
  if (!checks.length) return null;
  const n = checks.filter((c) => c.held).length;
  const verdict = n === checks.length ? 'Verified' : n === 0 ? 'Not verified' : 'Partly verified';
  const f = claims.fahrenheit;
  const parts = checks.map((c) => {
    const err = c.kind === 'precip' ? `${c.error >= 0 ? '+' : ''}${round1(c.error)} mm` : `${c.error >= 0 ? '+' : ''}${round1(c.error)} °C`;
    return `the observed ${LABEL[c.kind]} was ${fmt(c.kind, c.observed, f)} against the forecast ${fmt(c.kind, c.forecast, f)}, an error of ${err}, ${c.held ? 'within' : 'outside'} the tolerance (${c.allow})`;
  });
  const usedRef = checks.some((c) => c.from_reference);
  const src = usedRef ? 'the reference values given in the question' : observed?.source;
  const answer = `${verdict}. In ${placeName} on ${date}, ${parts.join('; ')}. Source: ${src}.`;
  return { verdict: verdict.toLowerCase().replace(' ', '_'), answer, checks };
}

// "at 51.5085,-0.1257 on 2026-11-19": the bare coordinate pair, which the
// shared parser only reads when it is the whole input.
export function coordsIn(text) {
  const m = String(text ?? '').match(/(?:^|[^\d.])(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)(?![\d.])/);
  if (!m) return null;
  const lat = Number(m[1]); const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? `${lat},${lon}` : null;
}
