// Watch-only instrumentation for the cross-intent handoff idea (see 2026-08-30
// planning session). Logs two things, changes nothing about what a caller
// gets back:
//
//   1. How many calls land on each of the 14 intents, and what status each
//      one answered with (ok / invalid_input / not_found / error).
//   2. Whenever a call lands on one intent but its question also carries the
//      dual-gate evidence (a strict structural signal AND a matching
//      keyword) for a DIFFERENT intent — a likely misroute.
//
// This exists to answer, with real traffic instead of a guess, whether
// misrouting happens often enough to be worth building a real handoff for,
// before any answer is ever changed. Nothing here alters req or res.

import { extractTxHash, extractAddress, extractHostname, extractIp, freeTextParam, tokenize } from './entityExtract.js';

const INTENT_BY_PATH = {
  '/check-tx': 'ONCHAIN_TX_LOOKUP',
  '/gas-price': 'GAS_PRICE',
  '/wallet-balance': 'WALLET_BALANCE_CHECK',
  '/token-holders': 'TOKEN_HOLDER_COUNT',
  '/tvl': 'TVL_LOOKUP',
  '/crypto-price': 'CRYPTO_PRICE',
  '/stock-price': 'STOCK_PRICE',
  '/ssl-check': 'SSL_VERIFICATION',
  '/weather-forecast': 'WEATHER_FORECAST',
  '/storm-alert': 'STORM_ALERT',
  '/ip-geolocate': 'IP_GEOLOCATION',
  '/academic-search': 'ACADEMIC_SEARCH',
  '/web-search': 'WEB_SEARCH',
  '/fraud-query': 'FRAUD_DETECTION',
  '/assess-wallet': 'FRAUD_DETECTION',
};

// Only the six intents Opus's review found have an unmistakable structural
// signal (a thing that could only mean that intent) AND a keyword to
// disambiguate it from the other intents sharing that same signal (an
// address alone could mean balance, holders, or fraud). Both must be present
// to count as a detection — a bare address or hostname with no keyword is
// not logged as a mismatch, same rule the real handoff would use.
const SAFE_SIGNALS = [
  {
    intent: 'ONCHAIN_TX_LOOKUP',
    hasStructural: (text) => Boolean(extractTxHash(text)),
    keywords: ['transaction', 'tx', 'confirm', 'confirmed', 'confirmation', 'block'],
  },
  {
    intent: 'WALLET_BALANCE_CHECK',
    hasStructural: (text) => Boolean(extractAddress(text)),
    keywords: ['balance', 'hold', 'holds', 'holding', 'worth', 'own'],
  },
  {
    intent: 'TOKEN_HOLDER_COUNT',
    hasStructural: (text) => Boolean(extractAddress(text)),
    keywords: ['holder', 'holders', 'how many wallets', 'how many addresses'],
  },
  {
    intent: 'FRAUD_DETECTION',
    hasStructural: (text) => Boolean(extractAddress(text)),
    keywords: ['scam', 'fraud', 'risk', 'suspicious', 'malicious', 'safe to'],
  },
  {
    intent: 'SSL_VERIFICATION',
    hasStructural: (text) => Boolean(extractHostname(text)),
    keywords: ['ssl', 'certificate', 'cert', 'https', 'tls'],
  },
  {
    intent: 'IP_GEOLOCATION',
    hasStructural: (text) => Boolean(extractIp(text)),
    keywords: ['located', 'location', 'where is', 'geolocat', 'country', 'city'],
  },
];

export function detectIntents(text) {
  if (!text) return [];
  const words = new Set(tokenize(text));
  const lower = text.toLowerCase();
  const hits = [];
  for (const signal of SAFE_SIGNALS) {
    if (!signal.hasStructural(text)) continue;
    const matchedKeyword = signal.keywords.find((kw) => (kw.includes(' ') ? lower.includes(kw) : words.has(kw)));
    if (matchedKeyword) hits.push({ intent: signal.intent, keyword: matchedKeyword });
  }
  return hits;
}

const callCounts = Object.create(null);
const statusCounts = Object.create(null);
const misrouteCounts = Object.create(null);
let totalCalls = 0;

// Kept low on purpose. The counters live in process memory, and the free
// Render plan spins the service down when it goes idle, so anything not yet
// printed is lost on the next restart. At 20 the summary had never once
// printed against real traffic volumes.
const SUMMARY_EVERY = 5;

function logSummary() {
  console.log(`[misroute-watch] summary after ${totalCalls} calls`);
  console.log(`[misroute-watch]   calls by intent: ${JSON.stringify(callCounts)}`);
  console.log(`[misroute-watch]   statuses by intent: ${JSON.stringify(statusCounts)}`);
  console.log(`[misroute-watch]   likely misroutes (called -> detected): ${JSON.stringify(misrouteCounts)}`);
}

export function extractRequestText(req) {
  const params = req.method === 'GET' ? req.query : req.body;
  if (!params || typeof params !== 'object') return null;

  // The engine often puts its whole question in a route's primary field,
  // such as location or topic, instead of question/query. Include every
  // top-level string so the watcher measures those real request shapes too.
  const values = [];
  const freeText = freeTextParam(params);
  if (freeText) values.push(freeText.trim());
  for (const value of Object.values(params)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const cleaned = value.trim();
    if (!values.includes(cleaned)) values.push(cleaned);
  }
  return values.length ? values.join(' ') : null;
}

// Mount once, before the intent routers, so it sees every call regardless of
// which one ends up handling it.
export function misrouteWatchMiddleware(req, res, next) {
  const intent = INTENT_BY_PATH[req.path];
  if (!intent) return next();

  totalCalls += 1;
  callCounts[intent] = (callCounts[intent] ?? 0) + 1;

  const question = extractRequestText(req);
  const detected = detectIntents(question).filter((hit) => hit.intent !== intent);
  for (const hit of detected) {
    const key = `${intent} -> ${hit.intent}`;
    misrouteCounts[key] = (misrouteCounts[key] ?? 0) + 1;
    console.log(`[misroute-watch] possible misroute: called=${intent} likely=${hit.intent} keyword="${hit.keyword}" question=${JSON.stringify(question)}`);
  }

  const sendJson = res.json.bind(res);
  res.json = (body) => {
    const status = body && typeof body === 'object' ? (body.status ?? 'unknown') : 'unknown';
    statusCounts[intent] = statusCounts[intent] ?? Object.create(null);
    statusCounts[intent][status] = (statusCounts[intent][status] ?? 0) + 1;
    return sendJson(body);
  };

  if (totalCalls % SUMMARY_EVERY === 0) logSummary();

  next();
}
