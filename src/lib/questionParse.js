// Pulls the answerable parts out of a whole natural-language question.
//
// Added 2026-08-29 after an adversarial review found /weather-forecast and
// /storm-alert answering "I cannot forecast weather" to "Will it rain in
// London tomorrow?" and "is there a storm risk in Miami this weekend" —
// the exact two questions miner.yaml advertises them as answering. The
// engine sends the caller's question through, and every competing weather
// miner on these intents parses one; we were rejecting them outright.
//
// Three things get read out of the text: the place, the day or window
// asked about, and the aspect emphasised (rain, wind, snow, freeze,
// storm, temperature) so the answer can lead with the thing that was
// actually asked instead of a generic range.

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Time and question vocabulary that is never part of a place name. Stripped
// off the ends of a location candidate so "London tomorrow" geocodes as
// "London" rather than failing outright.
const TIME_WORDS = [
  'right now', 'at the moment', 'currently', 'today', 'tonight', 'tomorrow',
  'this weekend', 'the weekend', 'this week', 'next week', 'this morning',
  'this afternoon', 'this evening', 'tomorrow morning', 'tomorrow afternoon',
  'tomorrow evening', 'tomorrow night', 'over the weekend',
  ...WEEKDAYS, ...WEEKDAYS.map((d) => `next ${d}`), ...WEEKDAYS.map((d) => `on ${d}`),
  'morning', 'afternoon', 'evening', 'night',
];

const LEADING_NOISE = /^(?:\s*(?:hi|hey|please|can you|could you|tell me|i want to know|what(?:'s| is| are)?|whats|how(?:'s| is)?|hows|will|is|are|do|does|show me|give me|find|search for|look up|check)\b[\s,]*)+/i;

// "in the next 48 hours", "over the next two days", "for the next 3 days"
const RELATIVE_WINDOW_RE = /\b(?:in|over|for|within|during)?\s*(?:the\s+)?next\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:calendar\s+)?(hour|hours|day|days)\b/i;

// The same window without "the next", e.g. "storm risk ... in 44 hours".
// Measured on the live question feed 2026-08-30: 50 of 90 weather/storm
// questions phrase the horizon this way, and none of them parsed, so every
// one silently fell back to the default window instead of the one asked for.
const BARE_WINDOW_RE = /\b(?:in|within|over)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(hour|hours|day|days)\b/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// Month names, long and abbreviated, for a question that names an actual
// calendar date. Added 2026-09-10: live traffic asked "Will Dubai reach 45C
// by September 13?" and the engine forwarded it as `when=September 13`.
// Nothing here parsed a named date, so parseWhen returned null, the route
// fell back to its default 3-day window, and we answered 2026-09-10 to
// 2026-09-12 — a window that does not contain the day asked about. The
// answer was confidently wrong rather than merely unhelpful.
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_INDEX = new Map();
for (let i = 0; i < MONTH_NAMES.length; i += 1) {
  MONTH_INDEX.set(MONTH_NAMES[i], i);
  MONTH_INDEX.set(MONTH_NAMES[i].slice(0, 3), i);
}
// "sept" is the one common abbreviation the 3-letter rule above gets wrong.
MONTH_INDEX.set('sept', 8);

const MONTH_ALT = [...MONTH_INDEX.keys()].sort((a, b) => b.length - a.length).join('|');
// "September 13", "Sept 13th", "September 13, 2026"
const MONTH_DAY_RE = new RegExp(String.raw`\b(${MONTH_ALT})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, 'i');
// "13 September", "13th of September 2026"
const DAY_MONTH_RE = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_ALT})\.?(?:,?\s+(\d{4}))?\b`, 'i');
// "by 13 September", "until September 13" — the question asks about the
// whole stretch between today and that date, not that one day alone.
const THROUGH_DATE_RE = /\b(?:by|until|till|through|before|ahead of|leading up to)\s*$/i;

// Whole days between two dates, counted on the calendar in UTC so a local
// clock near midnight cannot shift the answer by a day.
function daysBetweenUtc(from, to) {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86400000);
}

// Open-Meteo publishes 16 days of forecast. Past that there is no honest
// answer to give, and silently substituting a nearer window is exactly what
// produced the wrong-window bug in the first place.
export const MAX_FORECAST_DAY_OFFSET = 15;

// A named calendar date in `text`, in the same shape the rest of parseWhen
// returns, or null when no date is named. `outOfRange` is set when the date
// is real but beyond what any forecast covers, so the caller can say so
// instead of quietly answering about a different day.
export function parseCalendarDate(text, now = new Date()) {
  if (typeof text !== 'string') return null;

  let match = text.match(MONTH_DAY_RE);
  let monthName;
  let dayOfMonth;
  let year;
  if (match) {
    [, monthName, dayOfMonth, year] = match;
  } else {
    match = text.match(DAY_MONTH_RE);
    if (!match) return null;
    [, dayOfMonth, monthName, year] = match;
  }

  const month = MONTH_INDEX.get(monthName.toLowerCase());
  const day = Number(dayOfMonth);
  if (month == null || !Number.isInteger(day) || day < 1 || day > 31) return null;

  const explicitYear = year ? Number(year) : null;
  let target = new Date(Date.UTC(explicitYear ?? now.getUTCFullYear(), month, day));
  // Guards against a rolled-over date such as "February 31", which JS would
  // silently turn into March 3rd and we would then answer about.
  if (target.getUTCMonth() !== month || target.getUTCDate() !== day) return null;

  let offset = daysBetweenUtc(now, target);
  // A bare "January 5" asked in December means next January, not the one
  // already gone. Only applied when the caller named no year.
  if (offset < 0 && explicitYear == null) {
    target = new Date(Date.UTC(now.getUTCFullYear() + 1, month, day));
    offset = daysBetweenUtc(now, target);
  }
  if (offset < 0) return null;

  const label = `${MONTH_NAMES[month][0].toUpperCase()}${MONTH_NAMES[month].slice(1)} ${day}`;
  const isoDate = target.toISOString().slice(0, 10);
  if (offset > MAX_FORECAST_DAY_OFFSET) {
    return { label, date: isoDate, startDay: offset, days: 1, hours: (offset + 1) * 24, outOfRange: true };
  }

  // "by September 13" covers today through that date; a bare or "on"
  // September 13 means that one day.
  const through = THROUGH_DATE_RE.test(text.slice(0, match.index));
  if (through) {
    return { label: `through ${label}`, date: isoDate, startDay: 0, days: offset + 1, hours: (offset + 1) * 24 };
  }
  return { label, date: isoDate, startDay: offset, days: 1, hours: (offset + 1) * 24 };
}

const LAT_LON_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// Coordinates written out in words inside a sentence, e.g. "at latitude
// 14.6042, longitude 120.9822". Measured against the live question feed on
// 2026-08-30: this is the dominant phrasing on WEATHER_FORECAST and
// STORM_ALERT, 75 of 90 sampled questions, and every one of them was being
// refused as invalid_input because the only coordinate form recognised was
// a bare "lat,lon" string. Accepts lat/lon in either order and the common
// abbreviations, so "lon 120.9822 lat 14.6042" reads the same as the long
// form. Bearing suffixes (N/S/E/W) flip the sign.
const LABELLED_LAT_RE = /\blat(?:itude)?\b[\s:=]*(-?\d+(?:\.\d+)?)\s*(?:°\s*)?([NnSs])?/;
const LABELLED_LON_RE = /\b(?:lon(?:g(?:itude)?)?|lng)\b[\s:=]*(-?\d+(?:\.\d+)?)\s*(?:°\s*)?([EeWw])?/;

function applyBearing(value, bearing, negativeLetters) {
  if (!bearing) return value;
  const negative = negativeLetters.includes(bearing.toLowerCase());
  return negative ? -Math.abs(value) : Math.abs(value);
}

/**
 * Coordinates named anywhere in `text`, or null when it names none.
 * Returns { latitude, longitude } only when both are present and in range,
 * so a stray number in prose can never be mistaken for a position.
 */
export function parseCoordinates(text) {
  if (typeof text !== 'string') return null;

  const bare = LAT_LON_RE.exec(text);
  if (bare) {
    const latitude = Number(bare[1]);
    const longitude = Number(bare[2]);
    return inRange(latitude, longitude) ? { latitude, longitude } : null;
  }

  const lat = LABELLED_LAT_RE.exec(text);
  const lon = LABELLED_LON_RE.exec(text);
  if (!lat || !lon) return null;

  const latitude = applyBearing(Number(lat[1]), lat[2], ['s']);
  const longitude = applyBearing(Number(lon[1]), lon[2], ['w']);
  return inRange(latitude, longitude) ? { latitude, longitude } : null;
}

function inRange(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function stripTimeWords(text) {
  let out = text;
  let changed = true;
  // Repeat: "London tomorrow morning" sheds two separate trailing phrases.
  while (changed) {
    changed = false;
    const trimmed = out.trim().replace(/[?.!,;:]+$/, '').trim();
    for (const word of TIME_WORDS) {
      const re = new RegExp(`(?:^|\\s)(?:on|for|this|next|by)?\\s*${word}$`, 'i');
      if (re.test(trimmed)) {
        out = trimmed.replace(re, '').trim();
        changed = true;
        break;
      }
    }
    if (!changed) out = trimmed;
  }
  return out.replace(/\s+(?:in|on|for|at|over|during|within|the|a|an)$/i, '').trim();
}

// Ordered best-guess place candidates for `text`, most specific first. The
// caller geocodes them in turn and keeps the first that resolves, which is
// far more robust than trying to decide up front which one is right: a
// wrong guess costs one extra geocode call, not a failed answer.
// Cuts a trailing time window off a candidate place name, so the place is
// left behind on its own. "beijing over the next 48 hours" -> "beijing".
function stripWindowTail(value) {
  const match = value.match(/\s+(?:in|over|for|within|during|across|through)\s+(?:the\s+)?next\s/i);
  return match ? value.slice(0, match.index).trim() : value;
}

// Country abbreviations the geocoder does not understand. "London, UK"
// matches nothing there, and the bare "UK" left over as the next candidate
// matches a village called Uk in Irkutsk Oblast, Russia. That is what we
// answered a live storm alert with on 2026-09-07: confidently, and about
// the wrong hemisphere. Spelling the country out makes the full string
// resolve on its own, before any single-token candidate is reached.
const COUNTRY_ABBREVIATIONS = new Map([
  ['uk', 'United Kingdom'], ['u.k.', 'United Kingdom'], ['gb', 'United Kingdom'],
  ['us', 'United States'], ['u.s.', 'United States'], ['usa', 'United States'],
  ['u.s.a.', 'United States'], ['uae', 'United Arab Emirates'],
  ['nz', 'New Zealand'], ['nl', 'Netherlands'], ['de', 'Germany'],
  ['fr', 'France'], ['es', 'Spain'], ['it', 'Italy'], ['jp', 'Japan'],
  ['cn', 'China'], ['kr', 'South Korea'], ['za', 'South Africa'],
  ['ca', 'Canada'], ['au', 'Australia'], ['ie', 'Ireland'], ['ru', 'Russia'],
  ['br', 'Brazil'], ['mx', 'Mexico'], ['in', 'India'], ['ng', 'Nigeria'],
]);

// Country and US-state names that commonly trail a city with no comma
// between them. Live traffic on 2026-09-10 sent "Lagos Nigeria": the
// geocoder matched nothing for the pair, the next candidate was the bare
// capitalised run "Nigeria", and we answered with the country centroid —
// light drizzle at 20C, when Lagos itself was having a thunderstorm at
// 24.6C. The lowercase "lagos nigeria" had no capitalised run at all and
// was refused outright. Only "Lagos, Nigeria" worked, so a comma the
// caller had no reason to supply decided whether the answer was right.
const TRAILING_REGIONS = [
  'united kingdom', 'united states', 'united arab emirates', 'new zealand',
  'south africa', 'south korea', 'north korea', 'saudi arabia', 'sri lanka',
  'czech republic', 'dominican republic', 'costa rica', 'puerto rico',
  'hong kong', 'south sudan', 'new caledonia', 'papua new guinea',
  'nigeria', 'ghana', 'kenya', 'egypt', 'morocco', 'tanzania', 'uganda',
  'ethiopia', 'senegal', 'angola', 'zambia', 'zimbabwe', 'cameroon',
  'india', 'china', 'japan', 'france', 'germany', 'spain', 'italy',
  'portugal', 'greece', 'turkey', 'poland', 'sweden', 'norway', 'denmark',
  'finland', 'ireland', 'iceland', 'austria', 'belgium', 'netherlands',
  'switzerland', 'russia', 'ukraine', 'romania', 'hungary', 'bulgaria',
  'croatia', 'serbia', 'canada', 'mexico', 'brazil', 'argentina', 'chile',
  'colombia', 'peru', 'venezuela', 'ecuador', 'bolivia', 'uruguay', 'cuba',
  'jamaica', 'panama', 'guatemala', 'australia', 'indonesia', 'malaysia',
  'singapore', 'thailand', 'vietnam', 'philippines', 'pakistan',
  'bangladesh', 'nepal', 'israel', 'jordan', 'lebanon', 'iraq', 'iran',
  'qatar', 'kuwait', 'oman', 'bahrain', 'afghanistan', 'kazakhstan',
  'texas', 'california', 'florida', 'new york', 'louisiana', 'nevada',
  'arizona', 'colorado', 'illinois', 'georgia', 'ohio', 'michigan',
  'washington', 'oregon', 'massachusetts', 'virginia', 'maryland',
  'pennsylvania', 'north carolina', 'south carolina', 'new jersey',
  'new mexico', 'alabama', 'alaska', 'hawaii', 'utah', 'missouri',
  'minnesota', 'wisconsin', 'indiana', 'tennessee', 'kentucky', 'oklahoma',
  'kansas', 'iowa', 'arkansas', 'mississippi', 'connecticut', 'maine',
].sort((a, b) => b.split(' ').length - a.split(' ').length);

// Splits "Lagos Nigeria" into "Lagos, Nigeria" plus the bare city, so the
// pair resolves the way the comma'd form already does. Returns [] when the
// string has a comma already, names no known region, or is only the region.
export function splitTrailingRegion(value) {
  const text = String(value ?? '').trim();
  if (!text || text.includes(',')) return [];
  const lower = text.toLowerCase();
  for (const region of TRAILING_REGIONS) {
    if (!lower.endsWith(` ${region}`)) continue;
    const city = text.slice(0, text.length - region.length - 1).trim();
    if (city.length < 2) return [];
    // Keep the caller's own spelling of the region rather than ours, so
    // "Lagos NIGERIA" is not answered about a place called "Nigeria".
    const regionAsWritten = text.slice(text.length - region.length);
    return [`${city}, ${regionAsWritten}`, city];
  }
  return [];
}

// Rewrites a trailing country abbreviation to its full name, so
// "London, UK" becomes "London, United Kingdom" and a bare "UK" becomes
// "United Kingdom". Returns null when there is nothing to rewrite, so the
// caller can skip pushing a duplicate candidate.
export function expandCountryAbbreviation(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parts = text.split(',');
  const tail = parts[parts.length - 1].trim().toLowerCase();
  const full = COUNTRY_ABBREVIATIONS.get(tail);
  if (!full || full.toLowerCase() === tail) return null;
  return [...parts.slice(0, -1).map((part) => part.trim()), full].filter(Boolean).join(', ');
}

// The part before the first comma, which in a "City, Country" string is the
// more specific place and the one worth trying on its own. Returns null when
// there is no comma or the leading part is too short to be a place name.
function leadingCommaSegment(value) {
  const text = String(value ?? '');
  const index = text.indexOf(',');
  if (index < 0) return null;
  const head = text.slice(0, index).trim();
  return head.length >= 2 ? head : null;
}

export function locationCandidates(text) {
  if (typeof text !== 'string') return [];
  const raw = text.trim();
  if (!raw) return [];
  if (LAT_LON_RE.test(raw)) return [raw];

  const candidates = [];
  const push = (value) => {
    const cleaned = stripTimeWords(String(value ?? ''));
    if (cleaned.length >= 2 && cleaned.length <= 80 && !candidates.includes(cleaned)) {
      candidates.push(cleaned);
    }
  };

  // "weather in Tokyo", "storm risk near Miami this weekend"
  const prepositional = raw.match(/\b(?:in|at|near|around|for|over)\s+([^?.,;]+)/i);
  // Read the full proper-name run before the possessive. This preserves
  // multiword and punctuated places such as "New York's" and "St. John's".
  // Question contractions such as "What's" are ignored.
  const placeWord = String.raw`[A-Z][\w.-]*(?:[\u2019'][A-Za-z]+)?`;
  const placeConnector = String.raw`(?:of|de|del|la|las|le|les|el|van|von|der|den|da|do|dos)`;
  const possessivePlaceRe = new RegExp(`\\b((${placeWord})(?:\\s+(?:(?:${placeConnector})\\s+)?${placeWord})*)[\\u2019']s\\b`, 'g');
  const possessivePlaces = [...raw.matchAll(possessivePlaceRe)]
    .map((match) => {
      const name = match[1].replace(/^(?:What[\u2019']s|Give|Assess|Will|Can|Could|Please)\s+/i, '');
      return /^St\.\s/i.test(name) ? `${name}${match[0].slice(-2)}` : name;
    })
    .filter((name) => !/^(?:What|Who|Where|When|Why|How|It)$/i.test(name));
  // Place names are usually the capitalised run in an otherwise lowercase
  // question. Skips the first word, which may just be sentence case.
  const withoutLead = raw.replace(/^\W*\w+\s*/, '');
  const capitalised = withoutLead.match(/\b([A-Z][\w'-]*(?:\s+(?:of|de|del|la|le|el|van|der|den)\s+[A-Z][\w'-]*|\s+[A-Z][\w'-]*)*)/);

  // A structured `location=London` call must cost exactly one geocode, so
  // the string itself leads unless it is plainly a sentence — in which case
  // the extracted place leads instead and the sentence is the fallback.
  const looksLikeQuestion = /[?]/.test(raw) || raw.split(/\s+/).length > 3 || LEADING_NOISE.test(raw);
  const expanded = looksLikeQuestion ? null : expandCountryAbbreviation(raw);
  // A bare abbreviation is only ever meant as the country, so the spelled
  // out name leads. Left as-is, "UK" geocodes to a village in Siberia.
  if (expanded && !raw.includes(',')) push(expanded);
  if (!looksLikeQuestion) push(raw);

  // Both of these come before the capitalised run below, because on a
  // "City, ABBREV" string that run yields the bare abbreviation and the
  // geocoder will happily match it to some unrelated hamlet. Trying the
  // spelled-out country and then the city on its own settles it first.
  if (expanded) push(expanded);
  if (!looksLikeQuestion) {
    const head = leadingCommaSegment(raw);
    if (head) push(head);
  }

  // Before any single-token fallback: a "City Region" pair written without
  // a comma, which otherwise degrades to the region on its own.
  for (const candidate of splitTrailingRegion(raw)) push(candidate);

  for (const place of possessivePlaces) push(place);
  if (prepositional) push(prepositional[1]);
  // The same phrase with the time window cut off, and with no capital
  // letter required. "storm risk in beijing over the next 48 hours" only
  // ever produced "beijing over the next 48 hours", which matches no place,
  // and the capitalised run below cannot see a lowercase name at all, so the
  // whole question was refused. Live traffic sends lowercase city names,
  // confirmed 2026-09-05. Added after the untrimmed phrase, so anything that
  // already resolved still resolves on its first candidate.
  if (prepositional) push(stripWindowTail(prepositional[1]));
  // The same cut applied to the whole string, for the case where the place
  // leads and the window follows with no preposition in front of the place:
  // "beijing over the next 48 hours". The prepositional match above latches
  // onto the "over" and captures only "the next 48 hours", so without this
  // the place name never appears as a candidate at all.
  push(stripWindowTail(raw));
  if (capitalised) push(capitalised[1]);
  push(raw.replace(LEADING_NOISE, ''));
  push(raw);

  return candidates;
}

// What day or window the question asks about, as an offset in days from
// today plus a length. Returns null when the question names no time, so
// callers can keep their own default rather than being forced to one.
export function parseWhen(text) {
  if (typeof text !== 'string') return null;
  const t = text.toLowerCase();

  const relative = t.match(RELATIVE_WINDOW_RE) ?? t.match(BARE_WINDOW_RE);
  if (relative) {
    const n = NUMBER_WORDS[relative[1]] ?? Number(relative[1]);
    if (Number.isFinite(n) && n > 0) {
      const isHours = /hour/i.test(relative[2]);
      return {
        label: `the next ${relative[1]} ${relative[2]}`,
        startDay: 0,
        days: isHours ? Math.max(1, Math.ceil(n / 24)) : n,
        hours: isHours ? n : n * 24,
      };
    }
  }

  // A named calendar date is the most specific thing a question can carry,
  // so it is read before the vaguer "tomorrow"/"this week" phrases below.
  const calendar = parseCalendarDate(text);
  if (calendar) return calendar;

  if (/\btomorrow\b/.test(t)) return { label: 'tomorrow', startDay: 1, days: 1, hours: 48 };
  if (/\b(?:today|tonight|right now|currently|at the moment)\b/.test(t)) {
    return { label: /tonight/.test(t) ? 'tonight' : 'today', startDay: 0, days: 1, hours: 24 };
  }
  if (/\b(?:this|the|over the)\s+weekend\b/.test(t)) {
    // Saturday is day 6 in JS's 0-Sunday week; count forward to the next one,
    // and treat an in-progress weekend as starting today rather than skipping
    // to the following week.
    const today = new Date().getDay();
    const startDay = today === 0 ? 0 : (6 - today + 7) % 7;
    return { label: 'this weekend', startDay, days: today === 0 ? 1 : 2, hours: (startDay + 2) * 24 };
  }
  if (/\bnext week\b/.test(t)) return { label: 'next week', startDay: 7, days: 7, hours: 14 * 24 };
  if (/\bthis week\b/.test(t)) return { label: 'this week', startDay: 0, days: 7, hours: 7 * 24 };

  for (let i = 0; i < WEEKDAYS.length; i += 1) {
    if (new RegExp(`\\b${WEEKDAYS[i]}\\b`).test(t)) {
      const today = new Date().getDay();
      const startDay = (i - today + 7) % 7 || 7;
      return { label: WEEKDAYS[i][0].toUpperCase() + WEEKDAYS[i].slice(1), startDay, days: 1, hours: (startDay + 1) * 24 };
    }
  }
  return null;
}

// Which aspect of the weather the question is really about, so the answer
// can lead with it. Order matters: "will it snow" is a snow question even
// though snow implies cold.
const FOCUS_PATTERNS = [
  ['snow', /\bsnow(?:ing|fall)?\b|\bblizzard\b|\bsleet\b/i],
  ['storm', /\bstorm(?:s|y)?\b|\bthunder\w*\b|\bhurricane\b|\bcyclone\b|\btyphoon\b|\bgale\b/i],
  ['rain', /\brain(?:ing|fall|y)?\b|\bwet\b|\bprecipitation\b|\bshowers?\b|\bumbrella\b|\bdrizzl\w*\b/i],
  ['wind', /\bwind(?:y|s)?\b|\bgust\w*\b|\bbreez\w*\b/i],
  ['freeze', /\bfreez\w*\b|\bfrost\b|\bbelow zero\b|\bsub-?zero\b|\bice\b/i],
  ['temperature', /\btemperature\b|\bhow (?:hot|cold|warm)\b|\bdegrees?\b|\bhigh and low\b|\bhot\b|\bcold\b|\bwarm\b/i],
];

export function parseFocus(text) {
  if (typeof text !== 'string') return null;
  for (const [name, re] of FOCUS_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}
