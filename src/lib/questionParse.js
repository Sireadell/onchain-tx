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
const RELATIVE_WINDOW_RE = /\b(?:in|over|for|within|during)?\s*the\s+next\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(hour|hours|day|days)\b/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const LAT_LON_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

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
  // Place names are usually the capitalised run in an otherwise lowercase
  // question. Skips the first word, which may just be sentence case.
  const withoutLead = raw.replace(/^\W*\w+\s*/, '');
  const capitalised = withoutLead.match(/\b([A-Z][\w'-]*(?:\s+(?:of|de|del|la|le|el|van|der|den)\s+[A-Z][\w'-]*|\s+[A-Z][\w'-]*)*)/);

  // A structured `location=London` call must cost exactly one geocode, so
  // the string itself leads unless it is plainly a sentence — in which case
  // the extracted place leads instead and the sentence is the fallback.
  const looksLikeQuestion = /[?]/.test(raw) || raw.split(/\s+/).length > 3 || LEADING_NOISE.test(raw);
  if (!looksLikeQuestion) push(raw);

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

  const relative = t.match(RELATIVE_WINDOW_RE);
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
