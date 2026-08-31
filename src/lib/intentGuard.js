// Routes may receive a caller's whole question in place of a structured
// parameter. A question that has no words related to the route should be
// refused before an external service turns one stray word into an answer.

const QUESTION_LEAD_RE = /^\s*(?:what|which|who|where|when|why|how|is|are|was|were|do|does|did|can|could|would|will|should|tell|show|give|find|look\s+up|check|get)\b/i;

export function isQuestionLike(input) {
  if (typeof input !== 'string') return false;
  const text = input.trim();
  return text.includes('?') || QUESTION_LEAD_RE.test(text);
}

export function questionMatchesIntent(input, cuePattern) {
  if (!isQuestionLike(input)) return true;
  return cuePattern.test(String(input));
}

// The weather cues live here rather than inline at the call site so the
// tests exercise the pattern the route actually runs, not a copy of it that
// can drift. Both lists were widened after measuring them against the 2,000
// questions the network actually asked in the two weeks to 2026-08-31: the
// original list refused 15 of the 46 real WEATHER_FORECAST questions, six of
// which were answerable, because it matched "temperature" but not
// "temperatures", and because the most common phrasing on this network
// ("Will Dubai hit 45C this week?") names no weather word at all and carries
// the degree symbol as its only cue.
const DEGREE_CUE = String.raw`\d\s*(?:°|deg\b|degrees\b)`;

export const WEATHER_CUES = new RegExp(
  String.raw`(?:\b(?:weather|forecast|rain|rainfall|wind|winds|snow|storm|storms|freeze|frost|temperature|temperatures|hot|cold|warm|umbrella|precipitation|gust|gusts|thunder|hurricane|cyclone|typhoon|hail|sunny|cloudy|flood|flooding|heatwave|heat\s+wave|humidity|celsius|fahrenheit)\b|${DEGREE_CUE})`,
  'i',
);

// Narrower than WEATHER_CUES on purpose: /storm-alert answers a 48-hour
// disruption risk, so a seasonal climate question ("Will El Nino disrupt the
// Panama Canal?") is a genuine refusal here even though it is weather-shaped.
export const STORM_CUES =
  /\b(?:storm|storms|severe\s+weather|wind|winds|gust|gusts|gale|squall|thunder|thunderstorm|hail|hurricane|cyclone|typhoon|tornado|blizzard|flood|flooding|disruption\s+risk)\b/i;
