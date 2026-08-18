// Blockscout REST v2 transport for TOKEN_HOLDER_COUNT — a separate data
// source from ankrRpc.js's JSON-RPC (Ankr has no direct "holder count"
// method; that's an indexed/derived figure Blockscout maintains). No API
// key required — public instance, live-verified 2026-08-18 across all
// five chains. Retry/budget policy mirrors ankrRpc.js for the same reason
// (transient 429/5xx/timeout are worth a bounded retry); no token-bucket
// rate limiter here since there's no shared account quota to protect like
// there is with our own ANKR_API_KEY.

import { checkBudget } from './ankrRpc.js';

const BLOCKSCOUT_CALL_TIMEOUT_MS = Number(process.env.BLOCKSCOUT_CALL_TIMEOUT_MS) || 8_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const CACHE_TTL_MS = Number(process.env.BLOCKSCOUT_CACHE_TTL_MS) || 30_000;
const MAX_CACHE_ENTRIES = 500;

const cache = new Map();

export class TokenNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenNotFoundError';
  }
}

function isRetryableFailure(statusCode, errName) {
  if (errName === 'AbortError') return true;
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500) return true;
  return false;
}

export function resetBlockscoutCache() {
  cache.clear();
}

async function fetchBlockscout(host, path) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    checkBudget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BLOCKSCOUT_CALL_TIMEOUT_MS);
    let res;
    let ok = true;
    let statusCode;
    let errName;
    let networkErr;
    try {
      res = await fetch(`https://${host}${path}`, { signal: controller.signal });
      statusCode = res.status;
      ok = res.status === 200;
    } catch (err) {
      ok = false;
      errName = err.name;
      networkErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (ok) {
      return res.json();
    }

    if (statusCode === 404) {
      throw new TokenNotFoundError(`no token found at this address on this chain`);
    }

    const retryable = isRetryableFailure(statusCode, errName);
    const attemptsLeft = attempt < RETRY_DELAYS_MS.length;
    if (!retryable || !attemptsLeft) {
      if (errName === 'AbortError') {
        throw new Error(`Blockscout request timed out after ${BLOCKSCOUT_CALL_TIMEOUT_MS}ms (${attempt + 1} attempt(s))`);
      }
      if (networkErr) throw networkErr;
      throw new Error(`Blockscout request failed: ${statusCode} ${res.statusText} (${attempt + 1} attempt(s))`);
    }

    const base = RETRY_DELAYS_MS[attempt];
    const jitteredDelay = base * (0.7 + Math.random() * 0.6);
    await new Promise((r) => setTimeout(r, jitteredDelay));
  }
}

// Returns { holdersCount, name, symbol, decimals } for an ERC-20 token, or
// throws TokenNotFoundError if the address isn't a token Blockscout knows
// about on that chain.
export async function getTokenInfo(host, tokenAddress) {
  const key = `${host}:${tokenAddress}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
    return hit.value;
  }

  const body = await fetchBlockscout(host, `/api/v2/tokens/${tokenAddress}`);
  const value = {
    holdersCount: body.holders_count ?? null,
    name: body.name ?? null,
    symbol: body.symbol ?? null,
    decimals: body.decimals ?? null,
  };

  cache.set(key, { value, storedAt: Date.now() });
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return value;
}
