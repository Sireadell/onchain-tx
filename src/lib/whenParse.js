// Reads a point in time out of a free-text question: ISO stamps, "hour
// ending 15:00 UTC on October 26, 2023", "November 15th, 2023 at 10 AM
// Pacific Time", "yesterday at 3 PM UTC", "today 10 AM PST", "HE08:00 CST".
// Returns the start of the hour asked about as a UTC Date, or null when the
// question names no time (callers then use "now").

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ZONES = [
  { re: /\b(utc|gmt|z)\b/i, tz: 'UTC' },
  { re: /\b(pst|pdt|ppt|pt|pacific)\b/i, tz: 'America/Los_Angeles' },
  { re: /\b(cst|cdt|cpt|ct|central)\b/i, tz: 'America/Chicago' },
  { re: /\b(est|edt|ept|et|eastern)\b/i, tz: 'America/New_York' },
  { re: /\b(mst|mdt|mountain)\b/i, tz: 'America/Denver' },
  { re: /\b(cet|cest)\b/i, tz: 'Europe/Berlin' },
  { re: /\b(eet|eest)\b/i, tz: 'Europe/Helsinki' },
];

// Offset in minutes of a named zone at a given UTC instant, from the ICU data
// Node ships with.
function offsetMinutes(tz, utcMs) {
  if (tz === 'UTC') return 0;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
  return Math.round((asUtc - utcMs) / 60000);
}

export function zonedToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m, d, h, min);
  const off1 = offsetMinutes(tz, guess);
  const off2 = offsetMinutes(tz, guess - off1 * 60000);
  return new Date(guess - off2 * 60000);
}

export function zoneOf(text) {
  for (const z of ZONES) if (z.re.test(text)) return z.tz;
  return null;
}

function localYmd(now, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return new Date(Date.UTC(g('year'), g('month') - 1, g('day')));
}

function findDate(text, now, tz = 'UTC') {
  let m = text.match(/\b(20\d{2})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], m: +m[2] - 1, d: +m[3] };
  m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/i);
  if (m) return { y: +m[3], m: MONTHS.indexOf(m[1].toLowerCase()), d: +m[2] };
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})/i);
  if (m) return { y: +m[3], m: MONTHS.indexOf(m[2].toLowerCase()), d: +m[1] };
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (m) return { y: +m[3], m: +m[1] - 1, d: +m[2] };
  const base = localYmd(now, tz);
  if (/\byesterday\b/i.test(text)) base.setUTCDate(base.getUTCDate() - 1);
  else if (/\btomorrow\b/i.test(text)) base.setUTCDate(base.getUTCDate() + 1);
  else if (!/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/i.test(text)) return null;
  return { y: base.getUTCFullYear(), m: base.getUTCMonth(), d: base.getUTCDate(), relative: true };
}

// Hour asked about, as a start-of-interval hour (0-23). "Hour ending 15"
// and "HE15" mean the interval 14:00 to 15:00.
function findHour(text) {
  let m = text.match(/\b(?:hour[- ]ending|he)\s*:?\s*(\d{1,2})(?::(\d{2}))?/i);
  if (m) return { h: (+m[1] + 23) % 24, min: 0, ending: true };
  m = text.match(/\bT(\d{2}):(\d{2})/);
  if (m) return { h: +m[1], min: +m[2] };
  m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i);
  if (m) {
    let h = +m[1] % 12;
    if (/^p/i.test(m[3])) h += 12;
    return { h, min: +(m[2] ?? 0) };
  }
  m = text.match(/\b(?:at|for|from|interval)\s+(\d{1,2}):(\d{2})\b/i) || text.match(/\b(\d{1,2}):(\d{2})\s*(?:utc|gmt|z|pst|pdt|ppt|cst|cdt|est|edt|cet|cest)\b/i);
  if (m) return { h: +m[1], min: +m[2] };
  return null;
}

export function parseWhen(text, now = Date.now()) {
  const t = String(text ?? '');
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?/i);
  if (iso && (iso[6] || !zoneOf(t.replace(iso[0], '')))) {
    const off = iso[6] && iso[6].toUpperCase() !== 'Z' ? iso[6].replace(':', '') : '+0000';
    const sign = off[0] === '-' ? -1 : 1;
    const offMin = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
    const ms = Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5]) - offMin * 60000;
    return { at: new Date(ms), tz: 'UTC', hasDate: true, hasHour: true, ending: false };
  }
  const tz = zoneOf(t) ?? 'UTC';
  const date = findDate(t, now, tz);
  const hour = findHour(t);
  if (!date && !hour) return null;
  const n = localYmd(now, tz);
  const d = date ?? { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate(), relative: true };
  const at = zonedToUtc(d.y, d.m, d.d, hour ? hour.h : 0, hour ? hour.min : 0, tz);
  return { at, tz, hasDate: Boolean(date), relative: Boolean(!date || date.relative), hasHour: Boolean(hour), ending: Boolean(hour?.ending) };
}
