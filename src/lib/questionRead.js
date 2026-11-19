// Shared readers for the parts of a free-text question that every route keeps
// needing: the subject, a count, a block number, durations and ranges, a
// ticker, a token symbol and a chain.
//
// Why this exists: in the week of 2026-11-17 the same reading mistakes were
// fixed one route at a time, in commits 0cb3cfc and b6dd586 and before.
// Filler stayed in names ("Meteora DLMM in deposits ? Keep it brief"), a count
// was read as the topic ("top 5" made the news topic "5"), a duration was read
// as the value ("less than 30 days old"), "height N" and "19,000,000" blocks
// were missed, and a chain named after "on" lost to an earlier word such as
// "Base fee". Each reader here is tested against the real logged questions in
// questionRead.test.js, so a route can call one instead of growing its own
// regular expression.
//
// Every reader is narrow on purpose: it returns null when it is not sure, and
// the caller keeps whatever it did before.

import { CHAINS, resolveChainLoose, resolveRpcChainLoose, resolveTestnetLoose } from './chains.js';
import { hasLlmProvider, llmComplete } from './llmComplete.js';

/* ---------- numbers ---------- */

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, a: 1, an: 1, single: 1, dozen: 12,
};
const NUMBER_WORD_ALT = Object.keys(NUMBER_WORDS).filter((w) => w.length > 2).join('|');

// "19,000,000", "19_000_000", "19000000" or "1.8e+07" as a plain integer
// string, or null. The exponent form is what the request builder writes for a
// large block number; found live on TOKEN_TOTAL_SUPPLY.
export function parseIntegerText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().replace(/[,_]/g, '');
  if (/^\d+$/.test(s)) return BigInt(s).toString();
  if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s).toString();
  if (/^\d+(?:\.\d+)?e\+?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n) && n >= 0) return String(n);
  }
  return null;
}

function wordOrNumber(token) {
  const t = String(token).toLowerCase();
  if (NUMBER_WORDS[t] !== undefined) return NUMBER_WORDS[t];
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/* ---------- blocks ---------- */

// A block number written with comma or underscore groups, or a plain digit run.
const BLOCK_NUM = String.raw`(\d{1,3}(?:[,_]\d{3})+|\d+)(?![\d,_]*\d)`;
const BLOCK_NUM_LONG = String.raw`(\d{1,3}(?:[,_]\d{3})+|\d{4,})(?![\d,_]*\d)`;

// Ordered: the explicit "block N" forms first, then "height N", then the
// looser forms that need a long number to be safe.
const BLOCK_PATTERNS = [
  // "block 19,000,000", "block #18000000", "block number 110,500,000",
  // "block height 967,764", "Reference block: 60,000,000"
  new RegExp(String.raw`\bblock(?:\s+(?:number|height|no\.?|num))?\s*[#:]?\s*${BLOCK_NUM}(?!\s*(?:%|percent|seconds?|secs?|minutes?|mins?|hours?|days?|blocks|confirmations?|x\b))`, 'i'),
  // "on Ethereum height 20500000", "at height 840,000"
  new RegExp(String.raw`\bheight\s*[#:]?\s*${BLOCK_NUM}`, 'i'),
  // "the block reward at 947,955", "block subsidy at height 840000"
  new RegExp(String.raw`\bblock\s+(?:reward|subsidy|header|state|hash|timestamp)\s+(?:at|of|for|in)\s+(?:height\s+|block\s+)?#?${BLOCK_NUM_LONG}`, 'i'),
  // "the 18000000th block", "20,000,000 block"
  new RegExp(String.raw`${BLOCK_NUM_LONG}(?:st|nd|rd|th)?\s+block\b`, 'i'),
];

function withoutHex(text) {
  // Hashes and addresses carry digit runs that are never a block number.
  return String(text ?? '').replace(/0x[0-9a-fA-F]{8,}/g, ' ');
}

// The block a question names, as a plain integer string, or null.
export function readBlock(text) {
  if (text === null || text === undefined) return null;
  const clean = withoutHex(text);
  for (const re of BLOCK_PATTERNS) {
    const m = clean.match(re);
    if (m) return m[1].replace(/[,_]/g, '');
  }
  return null;
}

// "between blocks 55,000,000 and 55,000,002", "from block X to block Y",
// "blocks X-Y". Returns { from, to } in order, or null.
export function readBlockRange(text) {
  const t = withoutHex(text);
  const n = BLOCK_NUM_LONG;
  const m = t.match(new RegExp(String.raw`\bblocks?\s+${n}\s*(?:and|to|through|until|-|–)\s*(?:block\s+)?${n}`, 'i'))
    ?? t.match(new RegExp(String.raw`\bfrom\s+block\s+${n}\s+(?:to|through|until)\s+(?:block\s+)?${n}`, 'i'));
  if (!m) return null;
  const a = BigInt(m[1].replace(/[,_]/g, ''));
  const b = BigInt(m[2].replace(/[,_]/g, ''));
  return a <= b ? { from: a.toString(), to: b.toString() } : { from: b.toString(), to: a.toString() };
}

// A structured block parameter: a number in any of the forms above, a hex
// number, or "latest". Returns 'latest', an integer string, or null when the
// value is not a block at all.
export function readBlockValue(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^(?:latest|tip|current|now|head)$/i.test(s)) return 'latest';
  return parseIntegerText(s);
}

/* ---------- durations, ages and ranges ---------- */

const TIME_UNIT = String.raw`(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|quarters?|years?|yrs?)`;
const TIME_UNIT_RE = new RegExp(`^${TIME_UNIT}$`, 'i');
const NUM_OR_WORD = String.raw`(\d+(?:\.\d+)?|${NUMBER_WORD_ALT})`;

function unitName(u) {
  const t = u.toLowerCase();
  if (/^s/.test(t)) return 'second';
  if (/^mi|^min/.test(t)) return 'minute';
  if (/^h/.test(t)) return 'hour';
  if (/^d/.test(t)) return 'day';
  if (/^w/.test(t)) return 'week';
  if (/^mo/.test(t)) return 'month';
  if (/^q/.test(t)) return 'quarter';
  return 'year';
}

const DURATION_PATTERNS = [
  // "less than 30 days old", "under 2 hours old", "more than a year old"
  ['max_age', new RegExp(String.raw`\b(?:less\s+than|under|no\s+more\s+than|not\s+more\s+than|at\s+most|younger\s+than|newer\s+than|within)\s+${NUM_OR_WORD}\s*-?\s*${TIME_UNIT}\s+old\b`, 'i')],
  ['min_age', new RegExp(String.raw`\b(?:more\s+than|over|at\s+least|no\s+less\s+than|older\s+than)\s+${NUM_OR_WORD}\s*-?\s*${TIME_UNIT}\s+old\b`, 'i')],
  ['age', new RegExp(String.raw`\b${NUM_OR_WORD}\s*-?\s*${TIME_UNIT}\s+old\b`, 'i')],
  ['min_age', new RegExp(String.raw`\bolder\s+than\s+${NUM_OR_WORD}\s*${TIME_UNIT}\b`, 'i')],
  ['max_age', new RegExp(String.raw`\b(?:newer|younger|fresher)\s+than\s+${NUM_OR_WORD}\s*${TIME_UNIT}\b`, 'i')],
  // "in the last 6 months", "over the past 30 days", "during the previous week"
  ['lookback', new RegExp(String.raw`\b(?:(?:in|over|during|within|for|across)\s+)?(?:the\s+)?(?:last|past|previous|prior|trailing)\s+${NUM_OR_WORD}?\s*-?\s*${TIME_UNIT}\b`, 'i')],
  // "in the next 48 hours", "over the coming two weeks"
  ['ahead', new RegExp(String.raw`\b(?:(?:in|over|during|within|for)\s+)?(?:the\s+)?(?:next|coming|following)\s+${NUM_OR_WORD}?\s*-?\s*${TIME_UNIT}\b`, 'i')],
  // "3 days ago"
  ['ago', new RegExp(String.raw`\b${NUM_OR_WORD}\s*${TIME_UNIT}\s+ago\b`, 'i')],
  // "within 5 minutes of", "within 24 hours"
  ['within', new RegExp(String.raw`\bwithin\s+${NUM_OR_WORD}\s*${TIME_UNIT}\b`, 'i')],
  // "a 30-day average", "7 day window"
  ['window', new RegExp(String.raw`\b${NUM_OR_WORD}\s*-\s*${TIME_UNIT.replace(/s\?/g, '')}\b`, 'i')],
];

// Every time span the question states, classified, in the order found:
// [{ kind, value, unit, phrase, index }]. kind is one of max_age, min_age,
// age, lookback, ahead, ago, within, window. A route reads its own value
// (a price, a count, a level) from what is left, never from these.
export function readDurations(text) {
  let rest = String(text ?? '');
  const out = [];
  for (const [kind, re] of DURATION_PATTERNS) {
    const g = new RegExp(re.source, 'gi');
    for (const m of rest.matchAll(g)) {
      const value = m[1] === undefined ? 1 : wordOrNumber(m[1]);
      if (value === null) continue;
      out.push({ kind, value, unit: unitName(m[2]), phrase: m[0].trim(), index: m.index });
    }
    // Blank what was taken so a looser pattern below cannot read it again.
    rest = rest.replace(g, (s) => ' '.repeat(s.length));
  }
  return out.sort((a, b) => a.index - b.index);
}

const RANGE_NUM = String.raw`(-?\d+(?:,\d{3})*(?:\.\d+)?)`;
const RANGE_UNIT = String.raw`(%|percent|[a-zA-Z°µ/]{1,12}(?:\s+per\s+[a-z]+)?)?`;
const RANGE_QUAL = String.raw`(?:(?:expected|normal|allowed|acceptable|valid|safe|target|operating|specified)\s+)?`;
const RANGE_PATTERNS = [
  // "within the range of 1.0 to 5.0 meters", "in the range 10-20 C",
  // "within the expected range of 18-25°C"
  new RegExp(String.raw`\b(?:with)?in\s+(?:the\s+|a\s+|its\s+|an\s+)?${RANGE_QUAL}range\s+(?:of\s+)?${RANGE_NUM}\s*${RANGE_UNIT}\s*(?:to|-|–|and)\s*${RANGE_NUM}\s*${RANGE_UNIT}`, 'i'),
  // "between 2022 and 2023", "between 1.0 and 5.0 m"
  new RegExp(String.raw`\bbetween\s+${RANGE_NUM}\s*${RANGE_UNIT}\s+and\s+${RANGE_NUM}\s*${RANGE_UNIT}`, 'i'),
  // "within 1.0 to 5.0", "from 10 to 20 C", "within the expected -10°C to 40°C range"
  new RegExp(String.raw`\b(?:within|from)\s+(?:the\s+|its\s+|an?\s+)?${RANGE_QUAL}${RANGE_NUM}\s*${RANGE_UNIT}\s*(?:to|-|–)\s*${RANGE_NUM}\s*${RANGE_UNIT}`, 'i'),
];

const NOT_A_RANGE_UNIT = /^(?:and|to|or|the|a|an|of|in|on|at|for|with|is|are|was|by|meters?\s+per)$/i;

// Numeric ranges the question states: [{ min, max, unit, phrase, index }].
// "is the level within the range of 1.0 to 5.0 meters" is a bound to check
// against, never the reading itself.
export function readRanges(text) {
  const s = String(text ?? '');
  const out = [];
  let rest = s;
  for (const re of RANGE_PATTERNS) {
    const g = new RegExp(re.source, 'gi');
    for (const m of rest.matchAll(g)) {
      const a = Number(m[1].replace(/,/g, ''));
      const b = Number(m[3].replace(/,/g, ''));
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      let unit = (m[4] || m[2] || '').trim();
      if (TIME_UNIT_RE.test(unit)) unit = unitName(unit);
      if (NOT_A_RANGE_UNIT.test(unit)) unit = '';
      out.push({ min: Math.min(a, b), max: Math.max(a, b), unit: unit || null, phrase: m[0].trim(), index: m.index });
    }
    rest = rest.replace(g, (x) => ' '.repeat(x.length));
  }
  return out.sort((x, y) => x.index - y.index);
}

const ISO_DATE = String.raw`(\d{4}-\d{2}-\d{2})`;
const YEAR = String.raw`((?:19|20)\d{2})`;

// A date span the question names: "between 2022 and 2023", "from 2024-01-01
// to 2024-03-31", "since 2021". Returns { from, to, phrase } with ISO dates or
// years as written; to is null for an open "since". Null when none.
export function readDateRange(text) {
  const s = String(text ?? '');
  const pair = s.match(new RegExp(String.raw`\b(?:between|from)\s+${ISO_DATE}\s+(?:and|to|through|until|-)\s+${ISO_DATE}`, 'i'))
    ?? s.match(new RegExp(String.raw`\b(?:between|from)\s+${YEAR}\s*(?:and|to|through|until|-|–)\s*${YEAR}\b`, 'i'))
    ?? s.match(new RegExp(String.raw`\b${YEAR}\s*(?:-|–|to)\s*${YEAR}\b(?!\s*(?:\d|%))`, 'i'));
  if (pair) return { from: pair[1], to: pair[2], phrase: pair[0] };
  const since = s.match(new RegExp(String.raw`\b(?:since|after)\s+(${ISO_DATE.slice(1, -1)}|${YEAR.slice(1, -1)})\b`, 'i'));
  if (since) return { from: since[1], to: null, phrase: since[0] };
  return null;
}

// The question with its durations, ranges and date spans blanked out, so a
// route looking for "the number" in it cannot pick up a qualifier instead.
export function stripQualifiers(text) {
  let s = String(text ?? '');
  const spans = [...readDurations(s), ...readRanges(s)];
  const dr = readDateRange(s);
  if (dr) spans.push({ phrase: dr.phrase });
  for (const { phrase } of spans) s = s.replace(phrase, ' ');
  return s.replace(/\s{2,}/g, ' ').replace(/\s+([?.!,;])/g, '$1')
    .replace(/,(?:\s*,)+/g, ',').replace(/,\s*([?.!])/g, '$1').trim();
}

/* ---------- counts ---------- */

const COUNT_NUM = String.raw`(\d{1,3}|${NUMBER_WORD_ALT})`;
const AFTER_COUNT_NOT = String.raw`(?!\s*(?:%|percent|\.\d|,\d)|\s*-?\s*${TIME_UNIT}\b|\s+(?:blocks?|confirmations?|percent)\b)`;
const COUNT_LEAD = String.raw`(top|latest|first|last|best|biggest|largest|main|key|most\s+recent|recent|newest|leading)`;
const COUNT_TRAIL = String.raw`(?:latest|most\s+recent|newest|recent|top|main|key|biggest|largest|best|leading|current|breaking)`;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// How many items the question asks for: "top 5", "five latest", "10 most
// recent", "3 main bullet points". Pass nouns (e.g. ['headlines', 'stories'])
// to require that the number counts one of them; without nouns only the
// lead-word forms ("top 5", "5 latest") are read. Returns
// { count, phrase, rest } where rest is the question with the number removed,
// so the number can never become the topic. Null when no count is asked.
export function readCount(text, { nouns = null, max = 100 } = {}) {
  const s = String(text ?? '');
  const patterns = [];
  if (nouns?.length) {
    const noun = `(?:${nouns.map(escapeRe).join('|')})`;
    patterns.push(new RegExp(String.raw`\b${COUNT_LEAD}\s+${COUNT_NUM}\s+((?:[\w'-]+\s+){0,3}?)${noun}\b`, 'i'));
    patterns.push(new RegExp(String.raw`\b()${COUNT_NUM}\s+((?:[\w'-]+\s+){0,3}?)${noun}\b`, 'i'));
  } else {
    patterns.push(new RegExp(String.raw`\b${COUNT_LEAD}\s+${COUNT_NUM}\b${AFTER_COUNT_NOT}`, 'i'));
    patterns.push(new RegExp(String.raw`\b()${COUNT_NUM}\s+(?:of\s+the\s+)?${COUNT_TRAIL}\b`, 'i'));
  }
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    // A money amount or a version number is not a count.
    const before = s.slice(0, m.index + m[0].indexOf(m[2]));
    if (/[$€£#.]\s*$/.test(before)) continue;
    const count = wordOrNumber(m[2]);
    if (!Number.isInteger(count) || count < 1 || count > max) continue;
    const at = m.index + m[0].indexOf(m[2], m[1] ? m[1].length : 0);
    const rest = `${s.slice(0, at)}${s.slice(at + m[2].length)}`.replace(/\s{2,}/g, ' ').trim();
    return { count, phrase: m[0].trim(), rest };
  }
  return null;
}

/* ---------- tickers and token symbols ---------- */

// Upper-case words that are never a ticker or token symbol in a question.
const NOT_SYMBOLS = new Set(('US USA UK EU UAE USD EUR GBP JPY TVL APY APR ETF CEO CFO AI API LP NFT NFTS DEX CEX EVM '
  + 'ID IP OK FAQ PDF ROI GDP CPI KYC AML SLA SSL TLS DNS URL HTTP HTTPS JSON CSV XML ERC EIP BIP UTC GMT EST PST '
  + 'CET IST PM AM Q1 Q2 Q3 Q4 H1 H2 FY YTD YOY QOQ OTC IPO SEC FDA NASA MCC PAN GST GSTIN VAT IBAN SWIFT RPC '
  + 'L1 L2 PNL P&L TPS EOA DAO DAPP DEFI CEFI MEV AMM POS POW USDT_ IT IS OR AND THE TX TXS NO NOT ALL ANY '
  + 'NYSE NASDAQ AMEX LSE TSX ASX HKEX NSE BSE GAS WHAT HOW WHY WHO EH TH PH GH MH KB MB TB KM MPH KPH UUID MQTT '
  + 'HMAC SHA MD5 CVE CVSS ISO RFC UI UX OS VM CPU GPU RAM SSD').split(/\s+/));
// A ticker has two letters at least: "V3", "T1" and "G7" are not tickers.
const TWO_LETTERS = /[A-Z][^A-Z]*[A-Z]/;

// Exchange-prefixed ticker: "NASDAQ: AAPL", "NYSE:IBM".
const EXCHANGE_TICKER = /\b(?:NASDAQ|NYSE|AMEX|NYSEARCA|LSE|TSX|ASX|HKEX|NSE|BSE|OTC)\s*:\s*([A-Z][A-Z0-9.-]{0,9})\b/;
// Bracketed: "Microsoft Corporation (MSFT)", "Tether (USDT)", "($PEPE)".
const BRACKETED_TICKER = /\(\s*\$?([A-Z][A-Z0-9.]{0,9})\s*\)/g;
// Dollar-prefixed: "$PEPE", "$AAPL". Never a money amount ($150).
const DOLLAR_TICKER = /(?:^|[^\w$])\$([A-Za-z][A-Za-z0-9]{1,9})\b/;
// A bare all-caps word of 2 to 6 characters.
const CAPS_WORD = /(?<![A-Za-z0-9$_.-])([A-Z][A-Z0-9]{1,5})(?![A-Za-z0-9_])/g;

// The ticker a question names, upper case, or null. Order: exchange prefix,
// brackets, $SYMBOL, then the first bare all-caps word that is not a common
// abbreviation. `exclude` adds words to skip (a route can skip chain names).
export function readTicker(text, { exclude = [] } = {}) {
  const s = String(text ?? '');
  const skip = new Set([...NOT_SYMBOLS, ...exclude.map((x) => String(x).toUpperCase())]);
  const ex = s.match(EXCHANGE_TICKER);
  if (ex && !skip.has(ex[1])) return ex[1];
  for (const m of s.matchAll(BRACKETED_TICKER)) if (!skip.has(m[1])) return m[1];
  const dollar = s.match(DOLLAR_TICKER);
  if (dollar && !skip.has(dollar[1].toUpperCase())) return dollar[1].toUpperCase();
  for (const m of withoutHex(s).matchAll(CAPS_WORD)) if (!skip.has(m[1]) && TWO_LETTERS.test(m[1])) return m[1];
  return null;
}

// A token symbol may mix case ("cbBTC", "stETH", "USDbC", "bIBTA") but has
// at least two upper-case letters.
const SYMBOL = String.raw`((?=[a-z0-9]*[A-Z][a-z0-9]*[A-Z])[A-Za-z][A-Za-z0-9]{1,11})`;
const SYMBOL_PATTERNS = [
  new RegExp(String.raw`\(\s*\$?${SYMBOL}\s*\)`),
  new RegExp(String.raw`(?:^|[^\w$])\$${SYMBOL}\b`),
  new RegExp(String.raw`\b${SYMBOL}\s+(?:tokens?|balance|supply|holders?|price|reserves?|contract|vault|pool|coins?)\b`),
  new RegExp(String.raw`\b(?:balance|supply|price|holders?|reserves?|amount|units|yield|apy|APY|apr|APR)\s+(?:of|for|in)\s+(?:the\s+)?${SYMBOL}\b`),
  new RegExp(String.raw`\b[Hh]ow\s+many\s+${SYMBOL}\b`),
  new RegExp(String.raw`\b(?:hold|held|holds|own|owns)\s+(?:the\s+)?${SYMBOL}\b`),
];

// The token symbol a question asks about, as written, or null. With `known`
// (an array or object of symbols) the earliest known symbol in the text wins,
// matched without regard to case; otherwise the phrasing patterns above are
// used, so "the SHIB token", "$PEPE", "WETH balance" and "Tether (USDT)" all
// read, and "USD" or "TVL" never do.
export function readTokenSymbol(text, { known = null } = {}) {
  const s = withoutHex(text);
  if (known) {
    const list = Array.isArray(known) ? known : Object.keys(known);
    let best = null;
    for (const sym of list) {
      const m = new RegExp(`(?<![A-Za-z0-9])\\$?${escapeRe(sym)}(?![A-Za-z0-9])`, 'i').exec(s);
      if (m && (best === null || m.index < best.index || (m.index === best.index && sym.length > best.sym.length))) {
        best = { sym, index: m.index };
      }
    }
    return best ? best.sym : null;
  }
  // Patterns are in order of trust: brackets and $SYMBOL first.
  for (const re of SYMBOL_PATTERNS) {
    const m = re.exec(s);
    if (m && !NOT_SYMBOLS.has(m[1].toUpperCase())) return m[1];
  }
  return null;
}

/* ---------- chains ---------- */

// Words that look like a chain name and are not one: the "base fee" of a
// block, a "base and reward APY", "base units", "on-chain".
const CHAIN_FALSE_FRIENDS = [
  // "Base gas" and "Base price" are left alone: they usually mean the chain.
  /\bbase[\s-]*(?:fees?|units?|asset|currency|rate|case|model|version|apy|apr|salary|token\s+units?)\b/gi,
  /\bbase\s+(?:and|versus|vs\.?|or|plus)\s+(?:reward|incentive|bonus|boost)\w*/gi,
  /\b(?:the\s+)?(?:reward|incentive)\s+(?:and|versus|vs\.?|or)\s+base\b/gi,
  /\bdata\s*base\b/gi,
  /\bon[\s-]*chain\b/gi,
];

// Chain names a question uses that this miner does not cover, so a chain
// named after "on" is never silently swapped for an earlier supported word.
const OTHER_CHAINS = [
  'bnb smart chain', 'bnb chain', 'binance smart chain', 'bsc', 'solana', 'scroll', 'linea', 'zksync era', 'zksync',
  'gnosis chain', 'gnosis', 'celo', 'tron', 'bitcoin', 'monad', 'fantom', 'sonic', 'blast', 'mantle', 'mode',
  'zora', 'sui', 'aptos', 'near', 'ton', 'cosmos', 'cardano', 'polkadot', 'hyperliquid', 'berachain', 'unichain',
  'starknet', 'ethereum classic', 'litecoin', 'dogecoin', 'xrp ledger', 'sei', 'kava', 'cronos', 'moonbeam',
  'polygon zkevm', 'taiko', 'manta', 'metis', 'boba', 'harmony', 'klaytn', 'kaia', 'filecoin', 'stellar',
];

function neutraliseFalseFriends(text) {
  let s = String(text ?? '');
  for (const re of CHAIN_FALSE_FRIENDS) s = s.replace(re, (m) => ' '.repeat(m.length));
  return s;
}

// The question with "base fee", "base versus incentive", "on-chain" and the
// like blanked out (same length, so indexes still line up), for a route that
// scans words for a chain name its own way.
export function stripChainFalseFriends(text) {
  return neutraliseFalseFriends(text);
}

const SUPPORTED_NAMES = (() => {
  const names = new Set(Object.keys(CHAINS));
  for (const c of Object.values(CHAINS)) names.add(c.label.toLowerCase());
  for (const n of ['ethereum', 'mainnet', 'eth mainnet', 'ethereum mainnet', 'base mainnet', 'arb', 'arbitrum one', 'op',
    'op mainnet', 'optimism mainnet', 'matic', 'polygon pos', 'polygon mainnet', 'avax', 'avalanche mainnet',
    'avalanche c-chain', 'avalanche c chain', 'sepolia', 'base sepolia']) names.add(n);
  return names;
})();
const ALL_CHAIN_NAMES = [...new Set([...SUPPORTED_NAMES, ...OTHER_CHAINS])].sort((a, b) => b.length - a.length);
const CHAIN_NAME_ALT = ALL_CHAIN_NAMES.map((n) => escapeRe(n).replace(/\\ /g, '\\s+').replace(/-/g, '[\\s-]?')).join('|');
const CHAIN_MENTION_RE = new RegExp(`(?<![A-Za-z0-9])(${CHAIN_NAME_ALT})(?![A-Za-z0-9])`, 'gi');

function resolveName(name, rpc) {
  const n = name.toLowerCase().replace(/\s+/g, ' ').trim();
  const testnet = resolveTestnetLoose(n);
  if (testnet && /sepolia/.test(n)) return { chain: testnet, testnet: true };
  if (OTHER_CHAINS.includes(n)) return { chain: null, name: n };
  const chain = (rpc ? resolveRpcChainLoose : resolveChainLoose)(n === 'avalanche c chain' ? 'avalanche c-chain' : n);
  if (chain) return { chain };
  if (rpc && resolveChainLoose(n)) return { chain: null, name: n, noRpc: true };
  return null;
}

// Every chain the question names, in order: [{ name, chain, index }], where
// chain is the CHAINS (or TESTNETS) entry, or null for a chain this miner
// does not cover. False friends ("base fee", "on-chain") are skipped.
export function readChains(text, { rpc = false } = {}) {
  const s = neutraliseFalseFriends(text);
  const out = [];
  for (const m of s.matchAll(CHAIN_MENTION_RE)) {
    const raw = m[1];
    const before = s.slice(Math.max(0, m.index - 24), m.index);
    const after = s.slice(m.index + raw.length, m.index + raw.length + 24);
    const prepBefore = /\b(?:on|in|via|to|from|across|for|at|over|using)\s+(?:the\s+)?$/i.test(before) || /\(\s*$/.test(before);
    const chainAfter = /^\s*(?:mainnet|chain|network|l2|blockchain|testnet|tx|txn|transaction|wallet|address|history|block)\b/i.test(after)
      || /^\s*\)/.test(after);
    // Ticker-shaped names ("ETH", "AVAX", "OP", "MATIC") are usually the
    // coin, not the chain: read them only in a chain position.
    if (/^(?:eth|op|arb|avax|matic)$/i.test(raw) && !prepBefore && !chainAfter) continue;
    // Ordinary words that are also chain names: need a chain position, or a
    // capital letter and a sentence boundary after.
    if (/^(?:near|sei|ton|mode|sonic|blast|mainnet|base|scroll|manta|celo|sui|zora|kava|metis|boba)$/i.test(raw)) {
      const ok = prepBefore || chainAfter || (/^[A-Z]/.test(raw) && (m.index === 0 || /^\s*[,?.:;]/.test(after) || /^\s+\w/.test(after)));
      if (!ok) continue;
      if (/^(?:near|ton|mode|sonic|blast|sui|sei|mainnet)$/i.test(raw) && !prepBefore && !chainAfter) continue;
    }
    const r = resolveName(raw, rpc);
    if (!r) continue;
    out.push({ name: raw, chain: r.chain, index: m.index, ...(r.noRpc ? { noRpc: true } : {}) });
  }
  return out;
}

// The chain a question asks about, or null. A chain right after "on", "in",
// "via" or "across" wins over one named elsewhere ("Base fee and priority fee
// on Scroll" is about Scroll, which is not covered, so the answer is null and
// never Base). Otherwise the first chain named. Pass rpc: true to apply the
// RPC availability rule of resolveRpcChainLoose.
export function readChain(text, { rpc = false } = {}) {
  const found = readChainMention(text, { rpc });
  return found?.chain ?? null;
}

// Same as readChain but returns the mention, so a caller can name an
// unsupported chain in its answer: { name, chain|null, index }.
export function readChainMention(text, { rpc = false } = {}) {
  const s = neutraliseFalseFriends(text);
  const all = readChains(text, { rpc });
  if (!all.length) return null;
  const onChain = all.find((c) => /(?:\b(?:on|in|via|across|over|using)\s+(?:the\s+)?|\(\s*)$/i.test(s.slice(Math.max(0, c.index - 16), c.index)));
  return onChain ?? all[0];
}

/* ---------- subject ---------- */

// Trailing instruction sentences that carry no subject: "Keep it brief.",
// "Round sensibly.", "Mention when you read it.", "Sats please."
const INSTRUCTION_SENTENCE = /^(?:please\s+)?(?:keep|round|mention|answer|reply|respond|use|include|cite|state|be|give|show|report|return|format|express|explain|list|add|note|make|provide|write|sats|in\s+one|one\s+sentence|no\s+need|thanks|thank\s+you|just|only|ignore|do\s+not|don't|match|follow)\b/i;

// Leading framing before the question proper: "Ops:", "Desk question:",
// "For the weekly report,", "Before we list it,", "Hi,".
const LEAD_CONTEXT = [
  /^\s*[A-Z][A-Za-z]*(?:\s+[A-Za-z]+){0,3}\s*:\s+(?=\S)/,
  /^\s*(?:for|before|after|while|since|as\s+part\s+of)\s+(?:the|our|a|an|my|this|we|i)\s+[^,?]{1,40},\s*/i,
  /^\s*(?:hi|hey|hello|ok|okay|so|quick\s+one|quick\s+check)\b[,!.:]?\s+/i,
];

const LEAD_QUESTION = /^\s*(?:(?:what|which|who)(?:'s|\s+is|\s+are|\s+was|\s+were|\s+does|\s+do)?|whats|how(?:'s|\s+is|\s+are|\s+was|\s+big\s+is|\s+big\s+are|\s+large\s+is|\s+much(?:\s+is|\s+are|\s+was|\s+does|\s+do)?|\s+many(?:\s+are|\s+is)?)?|hows|tell\s+me(?:\s+about)?|show\s+me|give\s+me|get\s+me|find(?:\s+me)?|search(?:\s+for)?|look\s+up|lookup|check|verify|can\s+you(?:\s+tell\s+me|\s+check|\s+find|\s+give\s+me|\s+show\s+me|\s+look\s+up)?|could\s+you(?:\s+tell\s+me|\s+check|\s+find)?|please|do\s+you\s+know|i\s+(?:want|need|would\s+like)\s+(?:to\s+know|the)|is|are|does|did|was)\b[\s,]*/i;

// Phrases that name the kind of figure asked for, not the thing it is about.
const METRIC = String.raw`(?:total\s+value\s+locked(?:\s*\(tvl\))?|tvl|market\s+cap(?:italization)?|(?:share|stock|trading|spot|token|coin|current|live|latest|last|gas)?\s*prices?|exchange\s+rate|apy|apr|yield|staking\s+apy|interest\s+rate|balance|total\s+supply|circulating\s+supply|supply|holders?(?:\s+count)?|holder\s+count|number\s+of\s+holders|volume|trading\s+volume|liquidity|gas\s+price|gas\s+fees?|fees?|score|result|status|value|worth|tvl\s+figure|reserves?|deposits?|uptime|rating|ranking|rank|weather|forecast|temperature)`;
const METRIC_LEAD = new RegExp(String.raw`^(?:the\s+)?(?:(?:current|live|latest|total|overall|present|today'?s|real[\s-]?time|usd|dollar|exact|full|combined|net|staking|lending|borrow|annuali[sz]ed|attested|reported|audited|circulating)\s+)*${METRIC}(?:\s*\([^)]{1,12}\))?(?:\s+(?:and|&)\s+(?:[\w-]+\s+){0,2}[\w-]+)?\s+(?:of|in|for|on|at|across|held\s+in|locked\s+in|regarding|about)\s+`, 'i');

// "the latest news and developments about X", "academic papers on X"
const KIND = String.raw`(?:news|headlines?|stories|articles?|reports?|papers?|research|studies|study|literature|posts?|tweets?|discussions?|conversations?|reactions?|chatter|sentiment|opinions?|updates?|developments?|information|info|details|data|coverage|results)`;
const KIND_LEAD = new RegExp(String.raw`^(?:[\w'-]+\s+){0,6}?${KIND}(?:\s+(?:and|or|&)\s+${KIND})?(?:\s+on\s+(?:x|twitter|x\/twitter|reddit|bluesky))?\s+(?:about|on|regarding|concerning|covering|related\s+to|around|of|for|surrounding)\s+`, 'i');

// "capital sits in ether.fi", "gas on Gnosis", "unique addresses hold the SHIB":
// lower-case framing words up to a preposition or holding verb, when what
// follows starts like a name (a capital, a digit, a dot inside the word, $).
// Only framing words may be dropped this way, so a lower-case topic such as
// "the impact of AI" keeps its words.
const LOWER_LEAD = /^((?:[a-z][\w'-]*\s+){0,6}?)(?:of|in|into|for|about|on|at|across|regarding|hold|holds|held|own|owns|owned|by|from|behind|backing)\s+(?=(?:the\s+)?(?:[A-Z0-9$]|[a-z]+\.[a-z]))/;
const FRAME_WORDS = new Set(('the a an much many big large capital money funds value liquidity deposits deposited '
  + 'locked held sits sit is are was were currently gas fees fee unique wallet wallets addresses address accounts '
  + 'people holders users total amount how cost costs price prices stake staked there sitting parked tied up').split(/\s+/));

const TIME_FILLER = /\s*\b(?:right\s+now|at\s+the\s+moment|at\s+present|as\s+of\s+(?:now|today|right\s+now)|currently|today|tonight|these\s+days|now|live|this\s+week|this\s+month|so\s+far)\b\s*/gi;

// Words that may trail a name after a preposition and say nothing about it:
// "in deposits", "across all supported chains", "in US dollars".
const TAIL_FILLER_WORDS = new Set(('deposits deposit deposited all supported every chains chain networks network '
  + 'protocols protocol us usd dollars dollar terms total value locked tvl right now the moment today currently '
  + 'contracts contract its smart combined aggregate overall it sum it\'s various multiple different both '
  + 'market markets value price fiat cash euros euro gbp eur gwei wei sats satoshis units').split(/\s+/));

// Lower-case nouns that may trail a name and only say what kind of thing it
// is. Only dropped after a name-like word (a capital, a digit or a dot), so a
// lower-case topic such as "prediction markets blockchain" keeps its words.
const TAIL_NOUNS = /(\S+)\s+(?:protocol|protocols|contracts?|token|tokens|coin|coins|stablecoin|stock|shares?|platform|project|network|vaults?|lending|match|game|fixture|smart\s+contracts?)$/;

const ARTICLE_LEAD = /^(?:the|a|an|this|that|these|those|ongoing|upcoming|current|latest|recent|continuing|new|live)\s+/i;

const PAREN_FILLER = /\s*\((?:tvl|usd|apy|apr|in\s+usd|us\s+dollars?|gwei|approx\.?|approximately|roughly|estimated)\)/gi;

// Splits a question into sentences and drops instruction-only ones. Returns
// { core, instructions }: core is the sentence most likely to carry the
// subject (the first question, else the first non-instruction sentence).
// A sentence that only says why the question is asked: "Need this for an
// audit.", "For my records."
const CONTEXT_SENTENCE = /^(?:i\s+)?(?:need(?:ed)?|this\s+is|it'?s|for)\b[^?]{0,60}\b(?:audit|report|review|worksheet|records?|dashboard|reconciliation|compliance|treasury|workpaper|sheet|notes?)\b[^?]*[.!]$/i;

// Abbreviations whose full stop does not end a sentence ("Manchester United
// vs. Liverpool", "Unichem Labs Ltd. stock").
const NO_BREAK_BEFORE = /(?:\b(?:vs|v|inc|ltd|corp|co|st|mr|mrs|ms|dr|jr|sr|no|approx|est|dept|univ|e\.g|i\.e|u\.s|u\.k)|\b[A-Z])\.$/i;

function sentences(s) {
  const raw = s.split(/(?<=[.?!])\s+(?=[A-Z"'(])/);
  const out = [];
  for (const piece of raw) {
    if (out.length && NO_BREAK_BEFORE.test(out[out.length - 1])) out[out.length - 1] += ` ${piece}`;
    else out.push(piece);
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

export function splitInstructions(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const parts = sentences(s);
  const instructions = [];
  const keep = [];
  for (const p of parts) {
    const words = p.split(/\s+/).length;
    if (parts.length > 1 && !p.includes('?') && ((INSTRUCTION_SENTENCE.test(p) && words <= 14) || CONTEXT_SENTENCE.test(p))) instructions.push(p);
    else keep.push(p);
  }
  const core = keep.find((p) => p.includes('?')) ?? keep[0] ?? s;
  return { core, instructions };
}

function stripChainTail(s) {
  let out = s;
  let changed = true;
  while (changed) {
    changed = false;
    const re = new RegExp(String.raw`\s+(?:on|in|across|via|for|at)\s+(?:the\s+)?(?:${CHAIN_NAME_ALT})(?:\s+(?:mainnet|network|chain|blockchain|one|pos|l2|c-chain))*$`, 'i');
    if (re.test(out)) {
      out = out.replace(re, '').trim();
      changed = true;
    }
  }
  return out;
}

function stripTailNouns(s) {
  let out = s;
  let tail = out.match(TAIL_NOUNS);
  while (tail) {
    out = out.slice(0, tail.index + tail[1].length).trim();
    tail = out.match(TAIL_NOUNS);
  }
  const last = out.split(/\s+/).pop() ?? '';
  return out !== s && /[A-Z0-9.]/.test(last) ? out : s;
}

function stripFillerTail(s) {
  let out = s;
  for (let i = 0; i < 4; i += 1) {
    const m = out.match(/,?\s+(?:in|across|on|at|for|over|of|within|from|by)\s+((?:[\w'.]+\s*){1,4})$/i);
    if (!m) break;
    const words = m[1].trim().toLowerCase().split(/\s+/);
    if (!words.every((w) => TAIL_FILLER_WORDS.has(w))) break;
    out = out.slice(0, m.index).trim();
  }
  return out;
}

// The thing a question is about, with question words, filler, trailing
// instructions and time words removed, or null when nothing is left.
//   "How big is Meteora DLMM in deposits right now? Keep it brief." -> "Meteora DLMM"
//   "What is the Total Value Locked in PancakeSwap across all supported chains?" -> "PancakeSwap"
//   "What is the current price of BNB in US dollars?" -> "BNB"
// Options: stripChain removes a trailing "on <chain>" (for routes that read
// the chain separately); keepCase leaves capitalisation alone (always true,
// the subject is returned as written).
export function cleanSubject(text, { stripChain = false } = {}) {
  if (text === null || text === undefined) return null;
  let s = splitInstructions(text).core;
  for (const re of LEAD_CONTEXT) s = s.replace(re, '');
  // A short echo after the question mark ("...in Italy? 5", "...block? WBTC")
  // is a parameter the request builder appended, not part of the subject.
  s = s.replace(/\?\s*(?:\S+\s*){0,3}$/, '');
  s = s.replace(/[?!.]+\s*$/, '').replace(PAREN_FILLER, '').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(LEAD_QUESTION, '').trim();
    if (s === before) break;
  }
  s = s.replace(TIME_FILLER, ' ').replace(/\s{2,}/g, ' ').trim();
  const framed = s.replace(METRIC_LEAD, '').replace(KIND_LEAD, '').trim();
  if (framed !== s) {
    s = framed;
  } else {
    const lower = s.match(LOWER_LEAD);
    if (lower && lower[1].trim().split(/\s+/).filter(Boolean).every((w) => FRAME_WORDS.has(w.toLowerCase()))) {
      s = s.slice(lower[0].length).trim();
    }
  }
  s = s.replace(/\s+(?:have|has|hold|holds|got|cost|costs|trade|trades|trading|worth|currently|now|right\s+now)$/i, '').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    if (stripChain) s = stripChainTail(s);
    s = stripFillerTail(s);
    s = stripTailNouns(s);
    s = s.replace(/[\s,;:'"-]+$/, '').trim();
    if (s === before) break;
  }
  for (let i = 0; i < 3; i += 1) s = s.replace(ARTICLE_LEAD, '');
  s = s.replace(/[’']s$/i, '').replace(/^[\s,;:'"-]+|[\s,;:'"-]+$/g, '').trim();
  return s || null;
}

/* ---------- AI fallback ---------- */

// Last resort before a route refuses with "no <entity> found": ask a language
// model to read the named fields out of the question, as strict JSON. Free
// providers (Groq, Gemini) are tried by llmComplete after Perplexity, with no
// web search and a short budget. Returns an object with only the requested
// fields that came back as non-empty strings of a sane length, or null.
// Never throws.
export async function aiExtract(text, fields, { budgetMs = 4_000, describe = {} } = {}) {
  if (!hasLlmProvider() || !text || !Array.isArray(fields) || !fields.length) return null;
  const spec = fields.map((f) => `"${f}": ${describe[f] ? `${describe[f]}, ` : ''}string or null`).join('; ');
  const system = 'You read one value per field out of a user question. Reply with one JSON object and nothing else. '
    + `Fields: ${spec}. Copy each value exactly as the question writes it, without filler words, and use null when the question does not name it. Never guess.`;
  try {
    const { text: out } = await llmComplete(system, String(text).slice(0, 1_500), {
      budgetMs, maxTokens: 120, disableSearch: true, temperature: 0,
    });
    const json = String(out).match(/\{[\s\S]*\}/);
    if (!json) return null;
    const parsed = JSON.parse(json[0]);
    const result = {};
    for (const f of fields) {
      const v = parsed?.[f];
      if (typeof v === 'string' && v.trim() && v.trim().length <= 80 && !/^(?:null|none|n\/a|unknown)$/i.test(v.trim())) {
        result[f] = v.trim();
      }
    }
    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}
