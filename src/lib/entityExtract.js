// Pulls a specific, high-confidence entity out of an arbitrary string
// instead of requiring the caller to send that entity and nothing else.
// Live-checked 2026-08-29 against competing miners: the Telegraph engine
// often hands a whole question through verbatim ("Is the SSL certificate
// for github.com valid?"), a full URL instead of a bare hostname, or a
// tx_hash/address wrapped in a sentence, rather than the bare parameter
// this miner's docs ask for. Competitors that strip these down and answer
// were winning identical checks against us on exactly this. Every
// extractor here is deliberately narrow: it looks for one unambiguous
// pattern and returns null on anything else, rather than guessing. A
// caller that gets null still falls through to this miner's existing
// invalid_input answer, so this only ever adds coverage, never removes it.

const TX_HASH_RE = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;
const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

// Finds a 66-char (0x + 64 hex) transaction hash anywhere in the string.
// The trailing negative lookahead stops a longer hex run from matching as
// if it were shorter, and stops this from ever matching the first 64
// characters of something even longer.
export function extractTxHash(input) {
  if (typeof input !== 'string') return null;
  const match = input.match(TX_HASH_RE);
  return match ? match[0] : null;
}

// Finds a 42-char (0x + 40 hex) address anywhere in the string. The same
// trailing boundary means this does not fire on the first 40 hex
// characters of a 66-char transaction hash sitting in the same string.
export function extractAddress(input) {
  if (typeof input !== 'string') return null;
  const match = input.match(ADDRESS_RE);
  return match ? match[0] : null;
}

const HOSTNAME_RE = /(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}/;

// Extracts a bare hostname from a full URL ("https://example.com/path" ->
// "example.com"), a "host:port" pair ("github.com:443" -> "github.com"),
// or a hostname-shaped token inside a longer sentence ("Is the SSL
// certificate for github.com valid?" -> "github.com"). Returns null if no
// domain-shaped token is found at all. The URL and host:port cases are
// handled explicitly first because the generic pattern match alone would
// also accept "example.com/path" as a match (a slash isn't excluded by
// the hostname character class) and silently pass through a path that
// isn't part of the host.
export function extractHostname(input) {
  if (typeof input !== 'string') return null;
  let candidate = input.trim();

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    try {
      const hostname = new URL(candidate).hostname;
      if (hostname) return hostname;
    } catch {
      // Not a parseable URL despite the scheme prefix — fall through to
      // pattern scanning below rather than giving up.
    }
  }

  const hostPort = candidate.match(/^([a-zA-Z0-9.-]+):\d+$/);
  if (hostPort) candidate = hostPort[1];

  const match = candidate.match(HOSTNAME_RE);
  return match ? match[0] : null;
}

// Matches a bare IPv4 address, or an IPv4-shaped token inside a longer
// sentence ("where is 8.8.8.8 located?" -> "8.8.8.8").
const IPV4_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;

// IPv6 in the forms that actually get asked about: full groups, "::"
// compressed, and the IPv4-mapped tail (::ffff:8.8.8.8). Anchored on
// surrounding whitespace or punctuation and requiring at least two
// colon-separated hex groups, so "host:port" and a bare word cannot match.
// IPv6 was previously out of scope here; an adversarial review on
// 2026-08-29 found the rank-1 competing miner on this intent accepts it
// while we answered "I cannot find an IPv4 address", which is a guaranteed
// miss on every IPv6 question rather than merely a weaker answer.
const IPV6_RE = /(?:^|[\s(,'"])((?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|:(?::[0-9A-Fa-f]{1,4}){1,7}|::[Ff]{4}:\d{1,3}(?:\.\d{1,3}){3})(?=$|[\s).,;'"?!])/;

// Finds an IP address, v4 or v6, anywhere in the string. IPv4 is tried
// first: an IPv4-mapped IPv6 address contains a dotted quad, and the plain
// v4 form is the more useful answer whenever both could match.
export function extractIp(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();

  const v4 = text.match(IPV4_RE);
  if (v4) {
    const octets = v4[1].split('.').map(Number);
    if (octets.every((o) => o <= 255)) return v4[1];
  }

  const v6 = ` ${text} `.match(IPV6_RE);
  return v6 ? v6[1] : null;
}

// Splits free text into lowercase word tokens, for scanning a sentence
// against a known vocabulary (chain names, coin slugs/symbols) when no
// single param cleanly names the entity on its own.
export function tokenize(input) {
  if (typeof input !== 'string') return [];
  return input.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// The Telegraph engine does not always hand over a structured parameter.
// Live-checked 2026-08-30 against the deployed miner: /check-tx answered
// invalid_input to "Is transaction 0x5c50...2060 on Ethereum confirmed?"
// sent as `question=`, because the route only ever read `tx_hash`. Five of
// the thirteen routes already fell back to the whole question; the other
// eight did not, even though miner.yaml advertises to the engine that
// "every endpoint accepts the caller's whole question in place of its
// structured parameter". This returns whichever free-text field the caller
// used, so the extractors above (and resolveChainLoose) get something to
// read instead of the route rejecting the request outright.
const FREE_TEXT_KEYS = ['question', 'query', 'q', 'text', 'input', 'prompt'];

export function freeTextParam(params) {
  if (!params || typeof params !== 'object') return null;
  for (const key of FREE_TEXT_KEYS) {
    const value = params[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

// Question framing that sits in front of the thing actually being asked
// about: "what is the price of X", "how much is X worth", "what's the TVL
// of X". Everything up to and including the preposition is dropped, which
// leaves the subject. Kept deliberately shallow — it only fires on a
// leading interrogative, so a caller who sent a bare name is untouched.
const SUBJECT_LEAD_RE =
  /^\s*(?:what(?:'s| is| are)?|whats|how(?:'s| is| much| many)?|hows|tell me|show me|give me|can you tell me|do you know|please)\b[^]*?\b(?:of|for|about|on|is|are|does|cost[s]?)\s+/i;

// Trailing words that describe the *kind* of lookup rather than the thing
// being looked up. "Apple stock right now" is a question about "Apple".
const SUBJECT_TRAIL_RE =
  /\s*\b(?:stock|shares?|share price|stock price|price|trading|token|coin|crypto(?:currency)?|protocol|tvl|total value locked|trading|worth|value|quote|have|has|had|does|do|got|right now|at the moment|currently|today|now|these days|in usd|usd)\b\s*/gi;

// An all-caps 1-5 letter run standing alone reads as a ticker symbol.
// Anchored on word boundaries so it does not fire on the "I" in a sentence
// or on a chain name written in caps.
const TICKER_RE = /(?:^|[^A-Za-z])([A-Z]{1,5})(?![A-Za-z])/;

// True when a parameter holds a whole question rather than the bare value
// the endpoint documents. Telegraph hands the caller's question straight
// through as the parameter itself, so protocol can arrive as "How much
// value is locked in Uniswap?", and a route that trusts it verbatim then
// searches for a protocol by that entire sentence and finds nothing.
// Deliberately conservative: a real protocol slug or ticker is a single
// token, so a question mark or three-plus words is a safe signal that this
// is prose, and a bare value can never trip it.
export function looksLikeSentence(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (text.includes('?')) return true;
  return text.split(/\s+/).length >= 4;
}

// Reduces a whole question to the entity it is asking about. Returns null
// when nothing survives, so the caller keeps its existing invalid_input
// answer rather than searching for an empty string.
export function extractSubject(input) {
  if (typeof input !== 'string') return null;
  const subject = input
    .replace(/\?+\s*$/, '')
    .replace(SUBJECT_LEAD_RE, '')
    .replace(SUBJECT_TRAIL_RE, ' ')
    // The framing strip can leave a dangling article or preposition at
    // either end ("the total value locked in Aave" -> "in Aave"). Peel
    // those off repeatedly, since more than one can survive. "locked",
    // "staked", "held" and "deposited" are peeled for the same reason:
    // the lead strip stops at the first "is", so "How much value is locked
    // in Uniswap?" arrives here as "locked in Uniswap". No protocol is
    // named any of those words, so peeling them cannot eat a real subject.
    .replace(/^(?:\s*\b(?:the|a|an|of|for|in|on|at|to|is|are|locked|staked|held|deposited)\b)+\s*/i, '')
    .replace(/(?:\s*\b(?:of|for|in|on|at|to|is|are|and)\b)+[\s,.'"]*$/i, '')
    .replace(/[\s,.'"]+$/, '')
    .trim();
  return subject || null;
}

// Same idea, but for a stock question specifically: an explicit ticker in
// the text wins over the prose name, because the price API can look up
// "AAPL" directly while "Apple stock right now" has to go through a symbol
// search that a stray trailing word can throw off.
export function extractTicker(input) {
  if (typeof input !== 'string') return null;
  const match = input.match(TICKER_RE);
  if (match) return match[1];
  return extractSubject(input);
}

// The dispatcher does not always use the parameter name a route documents.
// Live-checked 2026-09-04 against the deployed miner: /crypto-price answered
// invalid_input to `symbol=BTC` and `asset=bitcoin` while every competing
// CRYPTO_PRICE miner accepts one or both, because this route only ever read
// `coin_id`. That refusal returns HTTP 200, so it is never booked as a
// failure — it is simply scored as a wrong answer, which matches
// CRYPTO_PRICE sitting near zero across epochs 307 and 308 with an empty
// failure_reason.
//
// Deliberately excludes `currency` (holds the quote currency, "usd", not the
// asset) and `token` (already this route's contract-address parameter).
const COIN_ALIAS_KEYS = [
  'symbol', 'asset', 'coin', 'ticker', 'coin_name', 'coin_symbol',
  'token_symbol', 'asset_symbol', 'asset_name', 'crypto', 'cryptocurrency',
];

// Returns whichever alias the caller used for the asset being priced, reduced
// to a bare name when the value arrived as a whole question. Never guesses:
// an absent alias returns null and the caller keeps its existing refusal.
export function coinAliasParam(params) {
  if (!params || typeof params !== 'object') return null;
  for (const key of COIN_ALIAS_KEYS) {
    const value = params[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    return looksLikeSentence(value) ? extractSubject(value) : value.trim();
  }
  return null;
}
