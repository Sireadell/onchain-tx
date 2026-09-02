// Narrow cross-intent handoffs for cases where the input itself proves the
// intended lookup. This deliberately does not try to classify general prose:
// an address, hash, or IP alone is never enough to reroute a request.

import { extractAddress, extractIp, extractTxHash, freeTextParam, tokenize } from './entityExtract.js';
import { withRpcBudget } from './ankrRpc.js';
import { handleCheckTx } from '../routes/checkTx.js';
import { handleWalletBalance } from '../routes/checkWalletBalance.js';
import { handleTokenHolders } from '../routes/checkTokenHolders.js';
import { handleIpGeolocation } from '../routes/checkIpGeolocation.js';

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
  const asksNativeAmountHeld = /\bhow much\s+(?:eth|matic|pol|bnb|avax|arb|op|ftm|celo|xdai)\s+is held by\b/i.test(text);
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

function detectHandoff(path, text, params) {
  if (!text) return null;
  if (hasIndependentStructuredInput(path, params, text)) return null;

  // A complete transaction hash takes precedence over any address also
  // mentioned in the same sentence. It is never safe to turn that into an
  // address lookup.
  if (path === '/check-tx' && !extractTxHash(text) && extractAddress(text)) {
    const cue = walletOrHolderCue(text);
    if (cue) return cue;
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

function targetRequest(req, text) {
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

  const routedReq = targetRequest(req, text);
  console.log(`[misroute-handoff] called=${endpointPath(req)} target=${target}`);
  const limiter = target === 'wallet'
    ? limiters.walletBalance
    : target === 'holders'
      ? limiters.tokenHolders
      : target === 'tx'
        ? limiters.transaction
        : limiters.ipGeolocation;
  if (!await runLimiter(limiter, req, res)) return undefined;
  if (target === 'wallet') return withRpcBudget(() => handleWalletBalance(routedReq, res));
  if (target === 'holders') return withRpcBudget(() => handleTokenHolders(routedReq, res));
  if (target === 'tx') return withRpcBudget(() => handleCheckTx(routedReq, res));
  return handleIpGeolocation(routedReq, res);
  };
}

export { detectHandoff, requestText };
