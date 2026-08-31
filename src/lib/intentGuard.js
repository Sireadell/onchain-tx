// Routes may receive a caller's whole question in place of a structured
// parameter. A question that has no words related to the route should be
// refused before an external service turns one stray word into an answer.

const QUESTION_LEAD_RE = /^\s*(?:what|which|who|where|when|why|how|is|are|was|were|do|does|did|can|could|would|will|should|tell|show|give|find|research|look\s+up|check|get)\b/i;

export function isQuestionLike(input) {
  if (typeof input !== 'string') return false;
  const text = input.trim();
  return text.includes('?') || QUESTION_LEAD_RE.test(text);
}

export function questionMatchesIntent(input, cuePattern) {
  if (!isQuestionLike(input)) return true;
  return cuePattern.test(String(input));
}

// Explicit free-text parameters (q/query/question) must always be checked.
// Structured values such as location=Miami and ticker=AAPL use the helper
// above so a bare entity remains valid.
export function freeTextMatchesIntent(input, cuePattern) {
  return typeof input === 'string' && cuePattern.test(input);
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
// "alert", "warning" and "advisory" are cues here only when they sit near a
// storm word ("storm warning", "hurricane advisory") — standalone they are
// too generic ("Will CAMZYOS get new safety warnings?" is a drug question,
// not a storm one, and must stay refused).
const STORM_WORD = String.raw`(?:storm|storms|weather|severe\s+weather|hurricane|cyclone|typhoon|tornado|flood|flooding)`;
const STORM_SIGNAL_WORD = String.raw`(?:alert|alerts|warning|warnings|advisory|advisories)`;
const NON_WEATHER_WARNING = String.raw`(?:bitcoin|crypto|account|drug|medicine|medical|patient|FDA|product|recall|stock|share|earnings|financial|bank|company)`;
export const STORM_CUES = new RegExp(
  String.raw`\b(?:storm|storms|severe\s+weather|wind|winds|gust|gusts|gale|squall|thunder|thunderstorm|hail|hurricane|cyclone|typhoon|tornado|blizzard|flood|flooding|disruption\s+risk)\b`
  + String.raw`|\b${STORM_WORD}\b(?:(?!\?).){0,20}\b${STORM_SIGNAL_WORD}\b`
  + String.raw`|\b${STORM_SIGNAL_WORD}\b(?:(?!\?).){0,20}\b${STORM_WORD}\b`
  // "under a warning" is conventional weather-alert wording. Keep it
  // behind the domain exclusion above so medical, product, government and
  // financial warnings do not become storm requests.
  + String.raw`|^(?!.*\b${NON_WEATHER_WARNING}\b).*\bunder\s+(?:an?\s+)?${STORM_SIGNAL_WORD}\b`,
  'i',
);

// GAS_CUES, STOCK_CUES and ACADEMIC_CUES were added in the same commit as
// WEATHER_CUES/STORM_CUES but, unlike those two, were never measured against
// real routed questions — GAS_PRICE and STOCK_PRICE traffic is too rare in
// the dispatcher's own log to sample the way weather's 46 real questions
// were. Hand-checked instead against realistic phrasings 2026-08-31 and
// found the same class of gap weather had: none of "How much would it cost
// me to send ETH on Base?", "What is NVDA at?" or "What do scholars say
// about federated learning?" matched the original narrower lists, each a
// genuinely answerable question refused outright. Widened accordingly.
const GAS_VERB = String.raw`(?:send|sending|transfer|transferring|transact|transacting|move|moving|swap|swapping|use|using|withdraw|withdrawing)`;
const GAS_COST_WORD = String.raw`(?:cost|costs|pay|paying|expensive|pricey|cheap|cheaper)`;
const GAS_CONTEXT = String.raw`(?:blockchain|crypto|wallet|network|chain|transaction|token|coin|ETH|ethereum|Base|Polygon|Arbitrum|Optimism|Avalanche)`;
const NON_BLOCKCHAIN_GAS = String.raw`(?:stove|oven|cooker|appliance|utility|petrol|gasoline|natural\s+gas|gas\s+station|fuel\s+station|Shell)`;
// 40 chars, not 25: "How pricey is Ethereum right now for a swap?" puts 30
// characters of filler between the cost word and the verb, which the
// original 25-char cap refused outright even though it names both halves
// of the cue.
export const GAS_CUES = new RegExp(
  String.raw`^(?!.*\b${NON_BLOCKCHAIN_GAS}\b)(?:.*\b(?:gas|gwei)\b.*`
  + String.raw`|(?=.*\b${GAS_CONTEXT}\b)(?=.*\bfees?\b).+`
  + String.raw`|(?=.*\b${GAS_CONTEXT}\b)(?=.*(?:\b${GAS_COST_WORD}\b(?:(?!\?).){0,40}\b${GAS_VERB}\b|\b${GAS_VERB}\b(?:(?!\?).){0,40}\b${GAS_COST_WORD}\b)).+`
  // "What does a transaction cost on Avalanche?" names the noun
  // "transaction" and a cost word but no verb from GAS_VERB ("transact" is
  // there, "transaction" is not) — still an unambiguous gas question.
  + String.raw`|(?=.*\btransactions?\b)(?=.*\b${GAS_COST_WORD}\b).+)$`,
  'i',
);

// "What is ETH worth?" must stay refused here — ETH is CRYPTO_PRICE's
// territory, not STOCK_PRICE's, and "worth" alone is a cue this list needs
// for real stock phrasing ("How much is TSLA worth today?"). The lookahead
// excludes any question naming a common crypto symbol or coin before the
// rest of the pattern is tried, so the generic cue words stay usable for
// stocks without also claiming crypto questions.
// "What is NVDA at?" names only a bare ticker and "at" — none of the
// generic cue words below appear in it, the same gap the weather list had
// for a bare degree reading.
export const STOCK_CUES = /\b(?:stock|stocks|share|shares|share\s+price|stock\s+price|ticker|equity|equities)\b/i;
// Case-insensitive so "How much is NVDA?" matches on "How", but the
// candidate word itself is captured and checked for being genuinely
// uppercase in the original string, so an ordinary lowercase word like
// "worth" in "What is ETH worth today?" can't masquerade as a ticker just
// because it precedes "today". Checking the captured token (not just "is
// there an uppercase word somewhere") also stops that same question passing
// because "ETH" happens to appear elsewhere in it.
// Four separate patterns, each tested (and its own candidate checked) on
// its own, rather than one alternation run once — a single combined regex
// stops at its first match and never backtracks past text it already
// consumed, so "What is the price of AAPL?" matched "the price" (candidate
// "the") on the first alternative and never got to try "price of AAPL" at
// all, since "price" had already been consumed.
const STOCK_TICKER_PATTERNS = [
  /\b([A-Za-z]{2,5})\b\s+(?:trading\s+at|price|today)\b/i,
  /\bprice\s+of\s+([A-Za-z]{2,5})\b/i,
  /\bhow\s+much\s+is\s+([A-Za-z]{2,5})\b/i,
  /\b([A-Za-z]{2,5})\b\s+at\b/i,
];
const COMMON_COMPANY_ASK = /(?:\b(?:Apple|Microsoft|Amazon|Google|Alphabet|Tesla|Nvidia|Meta)\b\s+(?:share\s+|stock\s+)?price\b|\bhow\s+is\s+(?:Apple|Microsoft|Amazon|Google|Alphabet|Tesla|Nvidia|Meta)\s+trading\b)/i;
// Common crypto ticker symbols, not just the spelled-out words — "What is
// XMR trading at?" names no word from the spelled-out list but XMR (Monero)
// is still CRYPTO_PRICE's territory, not STOCK_PRICE's.
const EXPLICIT_CRYPTO_WORDING = /\b(?:crypto(?:currency)?|bitcoin|ethereum|coin|token|BTC|ETH|SOL|XRP|BNB|ADA|DOGE|MATIC|AVAX|DOT|LINK|LTC|TRX|SHIB|UNI|ATOM|USDT|USDC|XMR|TON|PEPE)\b/i;
export function stockTextMatchesIntent(input) {
  if (typeof input !== 'string' || EXPLICIT_CRYPTO_WORDING.test(input)) return false;
  if (STOCK_CUES.test(input) || COMMON_COMPANY_ASK.test(input)) return true;
  return STOCK_TICKER_PATTERNS.some((pattern) => {
    const candidate = pattern.exec(input)?.[1];
    return candidate != null && candidate === candidate.toUpperCase();
  });
}

// Built from independently-anchored sub-patterns rather than one regex with
// a shared trailing $, because that shared $ forced every alternative to
// reach the end of the string — a bare cue word like "scholars" only
// matched when it was the very last word, refusing every real question that
// names it mid-sentence ("What do scholars say about federated learning?").
const ACADEMIC_EXCLUDE = String.raw`(?:news|newspaper|shopping|product\s+review|police|personal\s+journal|cheapest\s+flights?|flight\s+prices?|best\s+(?:laptops?|phones?|headphones?|shoes?|deals?))`;
const ACADEMIC_EXCLUDE_RE = new RegExp(String.raw`\b${ACADEMIC_EXCLUDE}\b`, 'i');
const ACADEMIC_WORD_CUES = /\b(?:academic|papers?|peer[- ]reviewed|scholars?|scholarly|cit(?:e|ed|ation|ations)|dissertation|meta[- ]analysis|systematic\s+reviews?|literature\s+reviews?|research\s+stud(?:y|ies)|recent\s+studies|stud(?:y|ies)\s+(?:paper|papers|research)|journal\s+(?:paper|papers|article|articles)|scientific\s+(?:articles?|papers?))\b/i;
const ACADEMIC_IMPERATIVE = /^(?:find|show(?:\s+me)?|get|search\s+for)\b.*\b(?:literature|publications?|articles?|stud(?:y|ies))\b/i;
const ACADEMIC_LITERATURE_SAYS = /\bliterature\s+(?:say|says)\b/i;
const ACADEMIC_RESEARCH_IMPERATIVE = /^(?:please\s+)?research\s+(?!(?:is|are|was|were|the\s+best)\b)\S.+/i;
export const ACADEMIC_CUES = {
  test(input) {
    const text = String(input);
    if (ACADEMIC_EXCLUDE_RE.test(text)) return false;
    return ACADEMIC_WORD_CUES.test(text)
      || ACADEMIC_IMPERATIVE.test(text)
      || ACADEMIC_LITERATURE_SAYS.test(text)
      || ACADEMIC_RESEARCH_IMPERATIVE.test(text);
  },
};
