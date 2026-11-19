// Checkable facts for FRAUD_RISK questions, found without any outside call:
// IP addresses in reserved ranges no real customer can connect from, email
// domains that hand out throwaway mailboxes, placeholder mailbox names, and
// the device and network signs a question states outright. Each fact names
// where it comes from, so a reader can check it.

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'guerrillamail.com', 'guerrillamail.net',
  'sharklasers.com', '10minutemail.com', '10minutemail.net', 'yopmail.com', 'yopmail.net', 'trashmail.com',
  'throwawaymail.com', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'mailnesia.com',
  'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempail.com', 'tempmailo.com',
  'burnermail.io', 'spamgourmet.com', 'mailcatch.com', 'moakt.com', 'tmail.ws', 'tempr.email', 'discard.email',
]);

const PLACEHOLDER_MAILBOX = /^(test|testing|demo|example|fake|asdf|qwerty|foo|bar|user|admin|abc|xyz|noreply|null)\d*$/i;

const RESERVED = [
  [(a, b, c) => a === 192 && b === 0 && c === 2, 'a documentation-range address (RFC 5737) that no real client can connect from'],
  [(a, b, c) => a === 198 && b === 51 && c === 100, 'a documentation-range address (RFC 5737) that no real client can connect from'],
  [(a, b, c) => a === 203 && b === 0 && c === 113, 'a documentation-range address (RFC 5737) that no real client can connect from'],
  [(a) => a === 10, 'a private address (RFC 1918) that cannot be a public sign-up IP, so it was spoofed or taken from behind a proxy'],
  [(a, b) => a === 172 && b >= 16 && b <= 31, 'a private address (RFC 1918) that cannot be a public sign-up IP, so it was spoofed or taken from behind a proxy'],
  [(a, b) => a === 192 && b === 168, 'a private address (RFC 1918) that cannot be a public sign-up IP, so it was spoofed or taken from behind a proxy'],
  [(a) => a === 127, 'a loopback address that only ever points at the same machine, so it cannot be a real visitor'],
  [(a, b) => a === 169 && b === 254, 'a link-local address that never crosses the internet, so it cannot be a real visitor'],
  [(a, b) => a === 100 && b >= 64 && b <= 127, 'a carrier-grade shared address (RFC 6598) used behind a provider\'s network, not a customer\'s own'],
  [(a, b) => a === 198 && (b === 18 || b === 19), 'a benchmarking-range address (RFC 2544) that no real client can connect from'],
  [(a) => a === 0 || a >= 240, 'a reserved address that no real client can connect from'],
];

const SIGNS = [
  [/\b(vpn|proxy|tor\b|tor exit|anonymi[sz]er)/i, 'connection through a VPN, proxy or Tor, which hides the real location', 0.12],
  [/\b(headless|automated browser|selenium|puppeteer|playwright|webdriver|(?<!not an? )bot\b)/i, 'an automated or headless browser, which points to a script rather than a person', 0.15],
  [/\b(mismatch|does not match|doesn'?t match|different country|billing.{0,20}shipping)/i, 'a mismatch between the stated identity, card or location details', 0.12],
  [/\b(velocity|multiple (accounts|attempts|cards|signups)|many (accounts|attempts|cards)|rapid(ly)?|in quick succession)/i, 'many attempts in a short time, a common sign of card testing or account farming', 0.12],
  [/\b(chargeback|stolen card|card testing|account takeover)/i, 'a stated history of chargebacks, stolen cards or takeovers', 0.15],
];

export function ipFacts(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const [a, b, c, d] = m.slice(1, 5).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) continue;
    const hit = RESERVED.find(([test]) => test(a, b, c));
    if (hit && !out.some((f) => f.startsWith(m[0]))) out.push(`${m[0]} is ${hit[1]} [IANA special-purpose address registry]`);
  }
  return out;
}

export function emailFacts(text) {
  const out = [];
  const seen = new Set();
  const s = String(text);
  for (const m of s.matchAll(/\b([a-z0-9._%+-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    const [, box, dom] = m;
    const domain = dom.toLowerCase();
    if (DISPOSABLE_DOMAINS.has(domain) && !seen.has(domain)) { seen.add(domain); out.push(`${domain} hands out throwaway mailboxes [disposable email domain list]`); }
    if (PLACEHOLDER_MAILBOX.test(box) && !seen.has(`@${box}`)) { seen.add(`@${box}`); out.push(`"${box}@" is a placeholder mailbox name typical of test or throwaway sign-ups [email checks]`); }
  }
  for (const domain of DISPOSABLE_DOMAINS) {
    if (seen.has(domain)) continue;
    if (new RegExp(`(^|[^a-z0-9.@-])${domain.replace(/\./g, '\\.')}\\b`, 'i').test(s)) { seen.add(domain); out.push(`${domain} hands out throwaway mailboxes [disposable email domain list]`); }
  }
  return out;
}

// The facts found, each with a weight for the score, strongest first.
export function fraudSignals(text) {
  const facts = [
    ...ipFacts(text).map((f) => [f, 0.25]),
    ...emailFacts(text).map((f) => [f, 0.2]),
    ...SIGNS.filter(([re]) => re.test(text)).map(([, f, w]) => [`${f} [stated in the details]`, w]),
  ];
  return facts;
}

const BAND = { 'High risk': [0.7, 0.95], 'Medium risk': [0.4, 0.69], 'Low risk': [0.05, 0.39] };

// A score from 0 to 1 inside the verdict's band: the model's own figure when
// it gave one, otherwise the band's floor plus the weight of the facts found.
export function riskScore(verdict, facts, modelScore = null) {
  const [lo, hi] = BAND[verdict] ?? [0.4, 0.69];
  const clamp = (n) => Math.min(hi, Math.max(lo, n));
  if (Number.isFinite(modelScore)) return Number(clamp(modelScore).toFixed(2));
  const weight = facts.reduce((sum, [, w]) => sum + w, 0);
  return Number(clamp(lo + weight * (hi - lo)).toFixed(2));
}
