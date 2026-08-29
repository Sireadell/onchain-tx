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
