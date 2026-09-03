// Narrow cross-intent handoffs for cases where the input itself proves the
// intended lookup. This deliberately does not try to classify general prose:
// an address, hash, or IP alone is never enough to reroute a request.

import { extractAddress, extractIp, extractTxHash, freeTextParam, tokenize } from './entityExtract.js';
import { withRpcBudget } from './ankrRpc.js';
import { handleCheckTx } from '../routes/checkTx.js';
import { handleWalletBalance } from '../routes/checkWalletBalance.js';
import { handleTokenHolders } from '../routes/checkTokenHolders.js';
import { handleIpGeolocation } from '../routes/checkIpGeolocation.js';
import { handleFraudAssessment } from '../routes/sentinelFraud.js';

function requestParams(req) {
  return req.method === 'GET' ? req.query : req.body;
}

function requestText(req) {
  const params = requestParams(req);
  if (!params || typeof params !== 'object') return null;

  const values = [];
  const freeText = freeTextParam(params);
  if (freeText) values.push(freeText.trim());
  for (const value of Object.values(params)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const trimmed = value.trim();
    if (!values.includes(trimmed)) values.push(trimmed);
  }
  return values.length ? values.join(' ') : null;
}

function hasAnyWord(text, words) {
  const tokens = new Set(tokenize(text));
  return words.some((word) => tokens.has(word));
}

function endpointPath(req) {
  const path = req.originalUrl.split('?')[0];
  return path.replace(/\/+$/, '') || '/';
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasIndependentStructuredInput(path, params, text) {
  const key = path === '/check-tx'
    ? 'tx_hash'
    : path === '/ssl-check'
      ? 'domain'
      : path === '/assess-wallet'
        ? 'wallet'
        : path === '/token-holders'
          ? 'token'
          : path === '/wallet-balance'
            ? 'address'
            : null;
  const value = key ? params?.[key] : null;
  return typeof value === 'string' && value.trim() && value.trim() !== text.trim();
}

// Decides whether a question carrying a bare address is asking for a native
// balance or a holder count. Returns null when the evidence points both ways
// or when the phrasing only looks like a balance question, so the caller can
// leave the request on the endpoint the dispatcher chose.
function walletOrHolderCue(text) {
  // "How many wallets hold contract 0x..." is a holder-count question,
  // not a request for the contract's native wallet balance. Keep this
  // narrow so general questions about wallets using or interacting with a
  // token remain on the endpoint the dispatcher chose.
  const countsWalletsOrAddresses = /\bhow many (?:unique\s+|distinct\s+)?(?:wallets|addresses)\b/i.test(text);
  const hasTokenOrContract = /\b(?:token|contract)\b/i.test(text);
  const knownAssetTickers = new Set([
    'BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE', 'MATIC', 'POL',
    'AVAX', 'DOT', 'LINK', 'LTC', 'TRX', 'SHIB', 'UNI', 'ATOM', 'USDT',
    'USDC', 'XMR', 'TON', 'PEPE', 'ARB', 'OP', 'DAI', 'WETH', 'WBTC',
  ]);
  const heldTicker = text.match(/\b(?:hold|holds|holding)\s+(?:any\s+)?([A-Z][A-Z0-9]{1,9})\b/);
  const hasAssetTicker = heldTicker ? knownAssetTickers.has(heldTicker[1]) : false;
  const hasHoldVerb = /\b(?:hold|holds|holding|holders?)\b/i.test(text);
  const explicitWalletHolderQuestion = countsWalletsOrAddresses
    && (hasTokenOrContract || hasAssetTicker)
    && hasHoldVerb;
  const unqualifiedWalletCountQuestion = countsWalletsOrAddresses
    && hasHoldVerb
    && !hasTokenOrContract
    && !explicitWalletHolderQuestion;
  if (unqualifiedWalletCountQuestion) return null;
  // "is held by" routinely arrives with an adverb in the middle ("is
  // currently held by", "is presently being held by"). Allow up to two
  // filler words so one adverb does not lose the whole cue, while keeping
  // the phrase anchored to "how much <native asset> ... held by" so the
  // ambiguous bare "held" cases below stay unmatched.
  const asksNativeAmountHeld = /\bhow much\s+(?:eth|matic|pol|bnb|avax|arb|op|ftm|celo|xdai)\s+is\s+(?:\w+\s+){0,2}held by\b/i.test(text);
  const walletCue = hasAnyWord(text, ['balance'])
    || (!explicitWalletHolderQuestion && hasAnyWord(text, ['hold', 'holds', 'holding']))
    || asksNativeAmountHeld;
  const holderCue = hasAnyWord(text, ['holder', 'holders'])
    || explicitWalletHolderQuestion;
  if (walletCue && holderCue) return null;
  if (walletCue) return 'wallet';
  if (holderCue) return 'holders';
  return null;
}


// A fraud assessment names what it wants in plain words. Confirmed in live
// traffic twice on 2026-09-03: the dispatcher sent "Intent: FRAUD_DETECTION.
// Assess fraud, abuse, malicious-contract, and counterparty risk ..." for a
// Base Sepolia address to /check-tx, which refused it for having no
// transaction hash while our own fraud endpoint could have answered it.
//
// Deliberately does not treat a bare "risk" as a cue. A transaction question
// can mention risk in passing, and every phrase below pairs it with the thing
// being assessed, so a genuine confirmation lookup never matches.
const FRAUD_WORDS = [
  'fraud', 'fraudulent', 'scam', 'scammer', 'scams',
  'malicious', 'phishing', 'illicit', 'sanctioned', 'blacklisted', 'blocklisted',
];
const FRAUD_PHRASES = [
  'fraud risk', 'counterparty risk', 'risk score', 'risk assessment',
  'malicious-contract', 'safe to send', 'safe to pay', 'safe to interact',
];

function fraudCue(text) {
  if (hasAnyWord(text, FRAUD_WORDS)) return true;
  const lower = text.toLowerCase();
  return FRAUD_PHRASES.some((phrase) => lower.includes(phrase));
}

function detectHandoff(path, text, params) {
  if (!text) return null;
  if (hasIndependentStructuredInput(path, params, text)) return null;

  // A complete transaction hash takes precedence over any address also
  // mentioned in the same sentence. It is never safe to turn that into an
  // address lookup.
  if (path === '/check-tx' && !extractTxHash(text) && extractAddress(text)) {
    const cue = walletOrHolderCue(text);
    if (cue) return cue;
    // Checked only after the balance and holder cues, so a question that
    // names one of those keeps the destination it already had.
    if (fraudCue(text)) return 'fraud';
  }

  // These two intents get swapped for each other directly, in both
  // directions: a balance question routed to the holder count, or a holder
  // question routed to the balance. The dispatcher supplies token or address
  // when it is confident, so the misrouted calls arrive carrying only the
  // question, and hasIndependentStructuredInput above already left the
  // confident ones alone. Only move a call when the cue names the other
  // endpoint, never when it merely agrees with the one already handling it.
  if (path === '/token-holders' && !extractTxHash(text) && extractAddress(text)) {
    if (walletOrHolderCue(text) === 'wallet') return 'wallet';
  }

  if (path === '/wallet-balance' && !extractTxHash(text) && extractAddress(text)) {
    if (walletOrHolderCue(text) === 'holders') return 'holders';
  }

  // Wallet questions land on the price intents in live traffic: two of the
  // 42 questions in the 2026-09-02 router run went that way, both asking
  // for a holding and both answered as a price. The gate is the same one
  // used above, an address plus an unambiguous balance or holder cue, which
  // a genuine price question never carries.
  if ((path === '/crypto-price' || path === '/stock-price') && !extractTxHash(text) && extractAddress(text)) {
    const cue = walletOrHolderCue(text);
    if (cue) return cue;
  }

  if ((path === '/fraud-query' || path === '/assess-wallet') && extractTxHash(text)) {
    const words = new Set(tokenize(text));
    const mentionsTx = words.has('transaction') || words.has('tx');
    const asksStatus = hasAnyWord(text, ['confirm', 'confirmed', 'confirmation', 'status']);
    if (mentionsTx && asksStatus) return 'tx';
  }

  if (path === '/ssl-check') {
    const ip = extractIp(text);
    const exactWhereIsIp = ip && new RegExp(`\\bwhere is\\s+${escapeRegex(ip)}\\b`, 'i').test(text);
    if (ip && (hasAnyWord(text, ['located', 'location', 'geolocate', 'country', 'city']) || exactWhereIsIp)) return 'ip';
  }

  return null;
}

function targetRequest(req, text, target) {
  // Sentinel reads the subject from `wallet` and the question from `query`,
  // and it is a real outbound HTTP call, so it gets a clean parameter set
  // rather than every field the original request happened to carry. The
  // chain identifiers are kept when present because a fraud verdict is
  // bound to one address on one chain.
  if (target === 'fraud') {
    const source = requestParams(req) ?? {};
    // `text` is every parameter joined together, which for this shape repeats
    // the address and chain that the question already names. Sentinel reads
    // this field as prose, so it gets the caller's own question verbatim when
    // there is one, and only falls back to the joined text otherwise.
    const fraudParams = { wallet: extractAddress(text), query: freeTextParam(source)?.trim() || text };
    if (typeof source.chain === 'string' && source.chain.trim()) fraudParams.chain = source.chain.trim();
    const chainId = source.chainId ?? source.chain_id;
    if (chainId !== undefined && String(chainId).trim()) fraudParams.chainId = String(chainId).trim();
    return req.method === 'POST'
      ? { method: 'POST', query: undefined, body: fraudParams }
      : { method: 'GET', query: fraudParams, body: undefined };
  }

  const params = { ...(requestParams(req) ?? {}), question: text };
  // The IP route's primary parameter is ip, while an SSL call commonly
  // carries the whole question in domain. Supplying it here is an internal
  // request translation, not an HTTP call back into this service.
  if (extractIp(text)) params.ip = text;
  return req.method === 'GET'
    ? { method: 'GET', query: params, body: undefined }
    : { method: 'POST', query: undefined, body: params };
}

function runLimiter(limiter, req, res) {
  if (!limiter) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(false);
      }
    };
    res.once('finish', finish);
    limiter(req, res, () => {
      if (!done) {
        done = true;
        res.off('finish', finish);
        resolve(true);
      }
    });
  });
}

// Returns a middleware with the same target protection as callers using the
// destination endpoint directly. The source limiter is mounted immediately
// before this middleware in app.js.
export function createMisrouteHandoffMiddleware(limiters) {
  return async function misrouteHandoffMiddleware(req, res, next) {
  const text = requestText(req);
  const target = detectHandoff(endpointPath(req), text, requestParams(req));
  if (!target) return next();

  const routedReq = targetRequest(req, text, target);
  console.log(`[misroute-handoff] called=${endpointPath(req)} target=${target}`);
  const limiter = target === 'wallet'
    ? limiters.walletBalance
    : target === 'holders'
      ? limiters.tokenHolders
      : target === 'tx'
        ? limiters.transaction
        : target === 'fraud'
          ? limiters.fraud
          : limiters.ipGeolocation;
  if (!await runLimiter(limiter, req, res)) return undefined;
  if (target === 'wallet') return withRpcBudget(() => handleWalletBalance(routedReq, res));
  if (target === 'holders') return withRpcBudget(() => handleTokenHolders(routedReq, res));
  if (target === 'tx') return withRpcBudget(() => handleCheckTx(routedReq, res));
  // Sentinel is an outbound HTTP call, not a chain RPC call, so it spends no
  // RPC budget and is not wrapped in it.
  if (target === 'fraud') return handleFraudAssessment(routedReq, res);
  return handleIpGeolocation(routedReq, res);
  };
}

export { detectHandoff, requestText };
