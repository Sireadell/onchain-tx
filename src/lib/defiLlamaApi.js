// DefiLlama public API transport for TVL_LOOKUP and CRYPTO_PRICE — a
// third data source alongside ankrRpc.js (live chain reads) and
// blockscoutApi.js (indexed token data). No API key required. Retry/cache
// policy mirrors blockscoutApi.js for the same reason (transient
// 429/5xx/timeout worth a bounded retry); reuses ankrRpc.js's
// checkBudget() so a slow call still counts against the same per-request
// wall-clock budget.

import { checkBudget } from './ankrRpc.js';

const DEFILLAMA_CALL_TIMEOUT_MS = Number(process.env.DEFILLAMA_CALL_TIMEOUT_MS) || 8_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const PROTOCOL_CACHE_TTL_MS = Number(process.env.DEFILLAMA_PROTOCOL_CACHE_TTL_MS) || 30_000;
const CHAIN_LIST_CACHE_TTL_MS = Number(process.env.DEFILLAMA_CHAIN_CACHE_TTL_MS) || 30_000;
const MAX_CACHE_ENTRIES = 500;

const protocolCache = new Map();
let chainListCache = null;
const priceCache = new Map();
const PRICE_CACHE_TTL_MS = Number(process.env.DEFILLAMA_PRICE_CACHE_TTL_MS) || 15_000;

export class ProtocolNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolNotFoundError';
  }
}

export class ChainNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChainNotFoundError';
  }
}

export class CoinNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoinNotFoundError';
  }
}

function isRetryableFailure(statusCode, errName) {
  if (errName === 'AbortError') return true;
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500) return true;
  return false;
}

export function resetDefiLlamaCache() {
  protocolCache.clear();
  chainListCache = null;
  priceCache.clear();
}

// DefiLlama splits its public API across multiple hosts by product —
// api.llama.fi for TVL/protocols, coins.llama.fi for prices. Confirmed
// live 2026-08-18 against production: calling /prices/current/* on
// api.llama.fi 404s (silently treated as "not found" by this transport's
// own retry logic, not a loud failure), so getting the host right per
// call matters, not just the path.
async function fetchDefiLlama(host, path) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    checkBudget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFILLAMA_CALL_TIMEOUT_MS);
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
      return res;
    }

    if (statusCode === 400 || statusCode === 404) {
      return res;
    }

    const retryable = isRetryableFailure(statusCode, errName);
    const attemptsLeft = attempt < RETRY_DELAYS_MS.length;
    if (!retryable || !attemptsLeft) {
      if (errName === 'AbortError') {
        throw new Error(`DefiLlama request timed out after ${DEFILLAMA_CALL_TIMEOUT_MS}ms (${attempt + 1} attempt(s))`);
      }
      if (networkErr) throw networkErr;
      throw new Error(`DefiLlama request failed: ${statusCode} ${res.statusText} (${attempt + 1} attempt(s))`);
    }

    const base = RETRY_DELAYS_MS[attempt];
    const jitteredDelay = base * (0.7 + Math.random() * 0.6);
    await new Promise((r) => setTimeout(r, jitteredDelay));
  }
}

// Returns current TVL in USD for a DefiLlama protocol slug (e.g.
// "uniswap"), or throws ProtocolNotFoundError. /tvl/{slug} returns a bare
// number on success, plain text "Protocol not found" on failure.
export async function getProtocolTvl(slug) {
  const key = `protocol:${slug}`;
  const hit = protocolCache.get(key);
  if (hit && Date.now() - hit.storedAt < PROTOCOL_CACHE_TTL_MS) {
    return hit.value;
  }

  const res = await fetchDefiLlama('api.llama.fi', `/tvl/${encodeURIComponent(slug)}`);
  if (res.status !== 200) {
    throw new ProtocolNotFoundError(`no DefiLlama protocol found for slug '${slug}'`);
  }
  const text = await res.text();
  const tvl = Number(text);
  if (!Number.isFinite(tvl)) {
    throw new ProtocolNotFoundError(`no DefiLlama protocol found for slug '${slug}'`);
  }

  protocolCache.set(key, { value: tvl, storedAt: Date.now() });
  if (protocolCache.size > MAX_CACHE_ENTRIES) {
    protocolCache.delete(protocolCache.keys().next().value);
  }
  return tvl;
}

// Returns the TVL for one protocol on one chain while keeping the total
// protocol TVL available separately. DefiLlama's /tvl/{slug} endpoint is
// aggregate-only, so questions such as "Aave V3 on Ethereum" require the
// richer /protocol/{slug} response and its currentChainTvls map.
export async function getProtocolChainTvl(slug, chainName) {
  const key = `protocol-chain:${slug}:${chainName.toLowerCase()}`;
  const hit = protocolCache.get(key);
  if (hit && Date.now() - hit.storedAt < PROTOCOL_CACHE_TTL_MS) return hit.value;

  const res = await fetchDefiLlama('api.llama.fi', `/protocol/${encodeURIComponent(slug)}`);
  if (res.status !== 200) {
    throw new ProtocolNotFoundError(`no DefiLlama protocol found for slug '${slug}'`);
  }
  const body = await res.json();
  const entries = Object.entries(body?.currentChainTvls ?? {});
  const match = entries.find(([name, value]) =>
    !name.toLowerCase().endsWith('-borrowed')
    && name.toLowerCase() === chainName.toLowerCase()
    && typeof value === 'number'
  );
  if (!match) {
    throw new ChainNotFoundError(`protocol '${slug}' has no DefiLlama TVL for chain '${chainName}'`);
  }
  const value = match[1];
  protocolCache.set(key, { value, storedAt: Date.now() });
  if (protocolCache.size > MAX_CACHE_ENTRIES) protocolCache.delete(protocolCache.keys().next().value);
  return value;
}

// Returns current TVL in USD for a chain name (e.g. "Ethereum", matched
// case-insensitively), or throws ChainNotFoundError. Whole /v2/chains list
// is cached together since it's one call regardless of which chain is
// asked for.
export async function getChainTvl(chainName) {
  if (!chainListCache || Date.now() - chainListCache.storedAt >= CHAIN_LIST_CACHE_TTL_MS) {
    const res = await fetchDefiLlama('api.llama.fi', '/v2/chains');
    if (res.status !== 200) {
      throw new Error(`DefiLlama /v2/chains request failed: ${res.status}`);
    }
    const list = await res.json();
    chainListCache = { value: list, storedAt: Date.now() };
  }

  const match = chainListCache.value.find(
    (c) => typeof c.name === 'string' && c.name.toLowerCase() === chainName.toLowerCase()
  );
  if (!match || typeof match.tvl !== 'number') {
    throw new ChainNotFoundError(`no DefiLlama chain found for name '${chainName}'`);
  }
  return match.tvl;
}

// Returns { priceUsd, symbol, asOfUnix } for a DefiLlama coin key, e.g.
// "coingecko:bitcoin" or "ethereum:0xA0b8...eB48" (chain:tokenAddress),
// or throws CoinNotFoundError. /prices/current/{key} omits the key
// entirely from the response `coins` object when it doesn't recognize it
// (200 status either way, not a 404) — that's the actual not-found signal
// here, not an HTTP status code.
export async function getCoinPrice(coinKey) {
  const cacheKeyStr = `price:${coinKey}`;
  const hit = priceCache.get(cacheKeyStr);
  if (hit && Date.now() - hit.storedAt < PRICE_CACHE_TTL_MS) {
    return hit.value;
  }

  const res = await fetchDefiLlama('coins.llama.fi', `/prices/current/${encodeURIComponent(coinKey)}`);
  if (res.status !== 200) {
    throw new CoinNotFoundError(`no DefiLlama price found for '${coinKey}'`);
  }
  const body = await res.json();
  const entry = body?.coins?.[coinKey];
  if (!entry || typeof entry.price !== 'number') {
    throw new CoinNotFoundError(`no DefiLlama price found for '${coinKey}'`);
  }

  const value = {
    priceUsd: entry.price,
    symbol: entry.symbol ?? null,
    asOfUnix: entry.timestamp ?? null,
  };
  priceCache.set(cacheKeyStr, { value, storedAt: Date.now() });
  if (priceCache.size > MAX_CACHE_ENTRIES) {
    priceCache.delete(priceCache.keys().next().value);
  }
  return value;
}
