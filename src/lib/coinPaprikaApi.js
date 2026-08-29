// CoinPaprika price source for CRYPTO_PRICE's coin_id mode. Added
// 2026-08-29 after finding CoinGecko's free API returns 403 from Render's
// datacenter IP in production, which meant market_cap_usd and
// change_24h_pct were always null in prod even though the code path for
// them was correct and worked in every local/test run. CoinPaprika is
// keyless and, live-checked from this same shell, actually reachable.
//
// coin_id here is the same CoinGecko-style slug the rest of this miner
// already accepts (e.g. "bitcoin", "ethereum"). CoinPaprika's own ids are
// "<symbol>-<slug>" (e.g. "btc-bitcoin"), so a caller-supplied coin_id is
// resolved to a real asset id via CoinPaprika's search endpoint
// (/v1/search), not by downloading its full ~13k-asset coin list. That
// full-list approach was the first design here and was replaced the same
// day: it fetched 7.4MB on the first crypto-price call after every
// process restart, and Render's free tier makes that restart happen on
// every redeploy (and, without an active keepalive, on every wake from
// idle) — a ~1.5-2s tax on whichever real request happened to be first.
// /v1/search returns the same exact-match result for a few KB in well
// under a second, live-checked 2026-08-29, and resolved ids are cached
// here afterward so the same input never pays for a second search.

import { checkBudget } from './ankrRpc.js';
import { tokenize } from './entityExtract.js';

const CALL_TIMEOUT_MS = Number(process.env.COINPAPRIKA_CALL_TIMEOUT_MS) || 5_000;
const RETRY_DELAYS_MS = [500, 1_000];
const PRICE_CACHE_TTL_MS = Number(process.env.COINPAPRIKA_CACHE_TTL_MS) || 60_000;
// Name/ticker -> asset id almost never changes, so this is cached far
// longer than a price quote — a resolution, once made, should not need
// another network round trip for the rest of the process's life under
// normal traffic.
const RESOLUTION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const priceCache = new Map();
const resolutionCache = new Map();

export function resetCoinPaprikaCache() {
  priceCache.clear();
  resolutionCache.clear();
}

export class CoinPaprikaNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoinPaprikaNotFoundError';
  }
}

function isRetryableFailure(statusCode, errName) {
  if (errName === 'AbortError') return true;
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500) return true;
  return false;
}

async function fetchJsonWithRetry(url) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    checkBudget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    let res;
    let ok = true;
    let statusCode;
    let errName;
    let networkErr;
    try {
      res = await fetch(url, { signal: controller.signal });
      statusCode = res.status;
      ok = res.status === 200;
    } catch (err) {
      ok = false;
      errName = err.name;
      networkErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (ok) return res.json();

    const retryable = isRetryableFailure(statusCode, errName);
    const attemptsLeft = attempt < RETRY_DELAYS_MS.length;
    if (!retryable || !attemptsLeft) {
      if (errName === 'AbortError') {
        throw new Error(`CoinPaprika request timed out after ${CALL_TIMEOUT_MS}ms (${attempt + 1} attempt(s))`);
      }
      if (networkErr) throw networkErr;
      throw new Error(`CoinPaprika request failed: ${statusCode} ${res.statusText} (${attempt + 1} attempt(s))`);
    }

    const base = RETRY_DELAYS_MS[attempt];
    const jitteredDelay = base * (0.7 + Math.random() * 0.6);
    await new Promise((r) => setTimeout(r, jitteredDelay));
  }
}

// Searches CoinPaprika for `query` and returns the best exact match: a
// result whose slug (the part of its id after the symbol prefix) or
// symbol equals `query` exactly, case-insensitive — never a loose
// full-text match, since /v1/search ranks by relevance, not correctness,
// and a fuzzy hit here would silently price the wrong asset. Among exact
// matches, the lowest `rank` wins (e.g. "bitcoin" also names an unrelated
// rank-10000+ copycat token; the real Bitcoin, rank 1, wins), matching
// how CoinGecko's own "bitcoin" id always resolves to the dominant asset.
// Returns null if nothing matched exactly.
async function searchExactAsset(query) {
  const normalized = query.toLowerCase();
  const url = `https://api.coinpaprika.com/v1/search/?q=${encodeURIComponent(query)}&c=currencies&limit=10`;
  const body = await fetchJsonWithRetry(url);
  const candidates = body?.currencies ?? [];

  let best = null;
  for (const coin of candidates) {
    if (!coin.is_active) continue;
    const dashIndex = coin.id.indexOf('-');
    const slug = dashIndex === -1 ? coin.id : coin.id.slice(dashIndex + 1);
    const isExactMatch = slug === normalized || (coin.symbol && coin.symbol.toLowerCase() === normalized);
    if (!isExactMatch) continue;
    const rank = coin.rank || Infinity;
    if (!best || rank < best.rank) best = { id: coin.id, rank };
  }
  return best;
}

// Resolves a caller-supplied coin_id to a CoinPaprika asset id, trying
// progressively looser interpretations: the input as a whole (as a slug
// or a ticker symbol, either resolves via searchExactAsset), then — if
// that fails and the input looks like free text rather than a single
// token — every word in it searched in parallel, lowest rank among any
// exact-match hits wins. Live-checked 2026-08-29: this is what turns
// "BTC" and "What is bitcoin worth" into the same resolved asset as plain
// "bitcoin". Resolutions are cached by the exact input string, so a
// second question phrased identically never searches again.
async function resolveCoinId(coinId) {
  const cacheKey = coinId.toLowerCase();
  const cached = resolutionCache.get(cacheKey);
  if (cached && Date.now() - cached.storedAt < RESOLUTION_CACHE_TTL_MS) return cached.entry;

  let entry = await searchExactAsset(coinId);

  if (!entry && /\s/.test(coinId)) {
    const words = tokenize(coinId);
    const results = await Promise.all(words.map((word) => searchExactAsset(word).catch(() => null)));
    for (const hit of results) {
      if (hit && (!entry || hit.rank < entry.rank)) entry = hit;
    }
  }

  resolutionCache.set(cacheKey, { entry, storedAt: Date.now() });
  return entry;
}

// Returns { priceUsd, symbol, marketCapUsd, change24hPct, asOfUnix } for a
// CoinGecko-style coin_id (e.g. "bitcoin"), or throws
// CoinPaprikaNotFoundError if no active CoinPaprika asset matches that
// slug. Any other failure throws a plain Error, same convention as
// coinGeckoApi.js — callers should treat that as "try another source".
export async function getCoinPaprikaPrice(coinId) {
  const cached = priceCache.get(coinId);
  if (cached && Date.now() - cached.storedAt < PRICE_CACHE_TTL_MS) return cached.value;

  const entry = await resolveCoinId(coinId);
  if (!entry) throw new CoinPaprikaNotFoundError(`no CoinPaprika asset found for '${coinId}'`);

  const ticker = await fetchJsonWithRetry(`https://api.coinpaprika.com/v1/tickers/${entry.id}`);
  const usd = ticker?.quotes?.USD;
  if (!usd || typeof usd.price !== 'number') {
    throw new CoinPaprikaNotFoundError(`no USD quote found for '${coinId}'`);
  }

  const value = {
    priceUsd: usd.price,
    symbol: ticker.symbol ?? null,
    marketCapUsd: typeof usd.market_cap === 'number' ? usd.market_cap : null,
    change24hPct: typeof usd.percent_change_24h === 'number' ? usd.percent_change_24h : null,
    asOfUnix: ticker.last_updated ? Math.floor(new Date(ticker.last_updated).getTime() / 1000) : null,
  };
  priceCache.set(coinId, { value, storedAt: Date.now() });
  return value;
}
