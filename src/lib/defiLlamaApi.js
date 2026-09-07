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
let protocolListCache = null;
const priceCache = new Map();
const PRICE_CACHE_TTL_MS = Number(process.env.DEFILLAMA_PRICE_CACHE_TTL_MS) || 15_000;
const PROTOCOL_LIST_CACHE_TTL_MS = Number(process.env.DEFILLAMA_PROTOCOL_LIST_CACHE_TTL_MS) || 300_000;

// Real rebrands/renames verified live against DefiLlama's own data
// (2026-08-30) rather than assumed — a plain slug/name search can't bridge
// these because the old and new names don't share any substring. Each one
// here was individually confirmed on the live API before being added:
// MakerDAO rebranded to Sky in 2024 and no longer appears under "maker" at
// all; Anyswap rebranded to Multichain (still listed, though the protocol
// itself is now defunct); "Avax" is a common shorthand for the Avalanche
// chain that DefiLlama's chain list doesn't itself recognize. Deliberately
// small and hand-verified rather than a large speculative list — an
// unverified guess here would misreport one protocol's TVL as another's.
// Fantom/Sonic was checked and excluded: DefiLlama tracks both as genuinely
// separate live chains, not a rename, so aliasing them would be wrong rather
// than just incomplete. Optimism/OP Mainnet was excluded here for the same
// reason and that still holds for protocol lookups, but the chain-level TVL
// list turned out to be a different case. See CHAIN_TVL_ALIASES below.
const PROTOCOL_ALIASES = {
  maker: 'sky-lending',
  makerdao: 'sky-lending',
  anyswap: 'multichain',
};
// The current name each retired name now trades under, for the answer text.
const PROTOCOL_REBRAND_NAMES = {
  maker: 'Sky Lending (formerly MakerDAO)',
  makerdao: 'Sky Lending (formerly MakerDAO)',
  anyswap: 'Multichain (formerly Anyswap)',
};
const CHAIN_ALIASES = {
  matic: 'Polygon',
  'bnb chain': 'BSC',
  bnb: 'BSC',
  avax: 'Avalanche',
};
// Chain-level TVL only (/v2/chains), deliberately NOT applied to a
// protocol's per-chain breakdown. Verified live 2026-09-07: DefiLlama's
// chain list carries dead $0 stub entries literally named "Optimism" and
// "Binance" sitting beside the real live entries "OP Mainnet" ($443M) and
// "BSC" ($5.79B), so asking for a chain by the name a person actually uses
// returned "$0.00 TVL" with full confidence. "Hyperliquid", the 7th largest
// chain at $1.54B, is listed only as "Hyperliquid L1" and wasn't found at
// all. The same check confirmed a protocol's own currentChainTvls map still
// keys those chains as "Optimism" and "Binance", which is why these aliases
// live in their own table instead of CHAIN_ALIASES: applying them to
// getProtocolChainTvl would break lookups that currently work.
// Fantom/Sonic stays excluded on purpose. Both are live, separately tracked
// chains ($4.86M and $16.5M), not a rename.
const CHAIN_TVL_ALIASES = {
  optimism: 'OP Mainnet',
  binance: 'BSC',
  'binance smart chain': 'BSC',
  hyperliquid: 'Hyperliquid L1',
};

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
  protocolListCache = null;
  priceCache.clear();
}

// Live-checked 2026-08-30: DefiLlama's /tvl/{slug} takes its slug literally,
// and a real, major, commonly-named protocol often isn't that literal
// string — "compound" 404s because the live slug is "compound-v3",
// "curve" because it's "curve-dex", "convex" because it's "convex-finance".
// A caller (or a natural-language question) giving the protocol's plain
// name is the common case, not an edge case, so a direct-slug miss falls
// back to a name search over the full protocol list before giving up.
// Among multiple name matches (versioned protocols list separately, e.g.
// "Compound V3"/"Compound V2"/"Compound V1"), the highest-TVL one is
// treated as the one a plain, unversioned name most likely means.
async function resolveProtocolSlug(rawSlug) {
  if (!protocolListCache || Date.now() - protocolListCache.storedAt >= PROTOCOL_LIST_CACHE_TTL_MS) {
    const res = await fetchDefiLlama('api.llama.fi', '/protocols');
    if (res.status !== 200) return null;
    const list = await res.json();
    protocolListCache = { value: list, storedAt: Date.now() };
  }

  const needle = rawSlug.trim().toLowerCase();
  const candidates = protocolListCache.value.filter(
    (p) => p.slug?.toLowerCase() === needle
      || p.name?.toLowerCase() === needle
      || p.slug?.toLowerCase().startsWith(`${needle}-`)
      || p.name?.toLowerCase().startsWith(`${needle} `)
  );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  return { slug: candidates[0].slug, name: candidates[0].name };
}

// The name to report a rebranded protocol under, so an answer states the
// number beside the entity DefiLlama actually measured. Only rewrites the
// retired names in PROTOCOL_ALIASES; anything else is returned as the
// caller wrote it. A static lookup, so no network call.
export function protocolDisplayName(rawSlug) {
  const trimmed = String(rawSlug).trim();
  return PROTOCOL_REBRAND_NAMES[trimmed.toLowerCase()] ?? trimmed;
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
export async function getProtocolTvl(rawSlug) {
  const trimmed = String(rawSlug).trim();
  const slug = PROTOCOL_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const key = `protocol:${slug}`;
  const hit = protocolCache.get(key);
  if (hit && Date.now() - hit.storedAt < PROTOCOL_CACHE_TTL_MS) {
    return hit.value;
  }

  let res = await fetchDefiLlama('api.llama.fi', `/tvl/${encodeURIComponent(slug)}`);
  let text = res.status === 200 ? await res.text() : null;
  let tvl = text !== null ? Number(text) : NaN;

  if (res.status !== 200 || !Number.isFinite(tvl)) {
    const resolved = await resolveProtocolSlug(slug);
    if (resolved) {
      res = await fetchDefiLlama('api.llama.fi', `/tvl/${encodeURIComponent(resolved.slug)}`);
      text = res.status === 200 ? await res.text() : null;
      tvl = text !== null ? Number(text) : NaN;
    }
  }

  if (!Number.isFinite(tvl)) {
    throw new ProtocolNotFoundError(`no DefiLlama protocol found for slug '${rawSlug}'`);
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
export async function getProtocolChainTvl(rawSlug, rawChainName) {
  const trimmedSlug = String(rawSlug).trim();
  const trimmedChain = String(rawChainName).trim();
  const slug = PROTOCOL_ALIASES[trimmedSlug.toLowerCase()] ?? trimmedSlug;
  const chainName = CHAIN_ALIASES[trimmedChain.toLowerCase()] ?? trimmedChain;
  const key = `protocol-chain:${slug}:${chainName.toLowerCase()}`;
  const hit = protocolCache.get(key);
  if (hit && Date.now() - hit.storedAt < PROTOCOL_CACHE_TTL_MS) return hit.value;

  let res = await fetchDefiLlama('api.llama.fi', `/protocol/${encodeURIComponent(slug)}`);
  if (res.status !== 200) {
    const resolved = await resolveProtocolSlug(slug);
    if (resolved) res = await fetchDefiLlama('api.llama.fi', `/protocol/${encodeURIComponent(resolved.slug)}`);
  }
  if (res.status !== 200) {
    throw new ProtocolNotFoundError(`no DefiLlama protocol found for slug '${rawSlug}'`);
  }
  const body = await res.json();
  const entries = Object.entries(body?.currentChainTvls ?? {});
  const match = entries.find(([name, value]) =>
    !name.toLowerCase().endsWith('-borrowed')
    && name.toLowerCase() === chainName.toLowerCase()
    && typeof value === 'number'
  );
  if (!match) {
    throw new ChainNotFoundError(`protocol '${rawSlug}' has no DefiLlama TVL for chain '${rawChainName}'`);
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
export async function getChainTvl(rawChainName) {
  const trimmed = String(rawChainName).trim();
  const chainName = CHAIN_TVL_ALIASES[trimmed.toLowerCase()]
    ?? CHAIN_ALIASES[trimmed.toLowerCase()]
    ?? trimmed;
  if (!chainListCache || Date.now() - chainListCache.storedAt >= CHAIN_LIST_CACHE_TTL_MS) {
    const res = await fetchDefiLlama('api.llama.fi', '/v2/chains');
    if (res.status !== 200) {
      throw new Error(`DefiLlama /v2/chains request failed: ${res.status}`);
    }
    const list = await res.json();
    chainListCache = { value: list, storedAt: Date.now() };
  }

  const matches = chainListCache.value.filter(
    (c) => typeof c.name === 'string' && c.name.toLowerCase() === chainName.toLowerCase()
  );
  // Prefer a live entry over a $0 one when both answer to the same name, so
  // a new dead stub appearing under a name we haven't aliased yet still
  // can't turn a real answer into "$0.00 TVL".
  const match = matches.find((c) => typeof c.tvl === 'number' && c.tvl > 0) ?? matches[0];
  if (!match || typeof match.tvl !== 'number') {
    throw new ChainNotFoundError(`no DefiLlama chain found for name '${rawChainName}'`);
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

// Returns the USD price a coin traded at on a past day, for the historical
// side of CRYPTO_PRICE. Same coinKey shape as getCoinPrice ("coingecko:
// bitcoin" or "ethereum:0xdAC1..."), so both of that route's modes are
// covered by the one call.
//
// DefiLlama is the only historical source here: CoinPaprika's historical
// endpoint is paid ("Getting minute historical data is not allowed in this
// plan", checked live 2026-09-07) and CoinGecko already 403s from this
// host. Live-checked 2026-09-07: coins.llama.fi/prices/historical returned
// BTC at $16542.46 for 2023-01-01 and USDT at $1 by contract address.
//
// Past prices never change, so these are cached far longer than live ones.
const HISTORICAL_PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const historicalPriceCache = new Map();

export async function getHistoricalCoinPrice(coinKey, unixSeconds) {
  const cacheKeyStr = `historical:${coinKey}:${unixSeconds}`;
  const hit = historicalPriceCache.get(cacheKeyStr);
  if (hit && Date.now() - hit.storedAt < HISTORICAL_PRICE_CACHE_TTL_MS) {
    return hit.value;
  }

  const res = await fetchDefiLlama(
    'coins.llama.fi',
    `/prices/historical/${unixSeconds}/${encodeURIComponent(coinKey)}`,
  );
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
    asOfUnix: entry.timestamp ?? unixSeconds,
  };
  historicalPriceCache.set(cacheKeyStr, { value, storedAt: Date.now() });
  if (historicalPriceCache.size > MAX_CACHE_ENTRIES) {
    historicalPriceCache.delete(historicalPriceCache.keys().next().value);
  }
  return value;
}
