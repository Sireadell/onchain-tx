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
  if (!looksLikeQuestion) push(raw);

  for (const place of possessivePlaces) push(place);
  if (prepositional) push(prepositional[1]);
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
