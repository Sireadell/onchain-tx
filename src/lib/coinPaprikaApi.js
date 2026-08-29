// CoinPaprika price source for CRYPTO_PRICE's coin_id mode. Added
// 2026-08-29 after finding CoinGecko's free API returns 403 from Render's
// datacenter IP in production, which meant market_cap_usd and
// change_24h_pct were always null in prod even though the code path for
// them was correct and worked in every local/test run. CoinPaprika is
// keyless and, live-checked from this same shell, actually reachable.
//
// coin_id here is the same CoinGecko-style slug the rest of this miner
// already accepts (e.g. "bitcoin", "ethereum"). CoinPaprika's own ids are
// "<symbol>-<slug>" (e.g. "btc-bitcoin"), so a slug -> id lookup is built
// from CoinPaprika's full coin list (/v1/coins, ~13k active assets) and
// cached for COIN_LIST_TTL_MS. Some slugs collide across multiple listed
// assets (e.g. "bitcoin" also names an unrelated rank-10000+ token); the
// lower `rank` value is kept, matching how CoinGecko's own "bitcoin" id
// always resolves to the dominant asset rather than a copycat.

import { checkBudget } from './ankrRpc.js';

const CALL_TIMEOUT_MS = Number(process.env.COINPAPRIKA_CALL_TIMEOUT_MS) || 5_000;
const RETRY_DELAYS_MS = [500, 1_000];
const PRICE_CACHE_TTL_MS = Number(process.env.COINPAPRIKA_CACHE_TTL_MS) || 60_000;
const COIN_LIST_TTL_MS = 12 * 60 * 60 * 1000;

const priceCache = new Map();
let slugToId = null;
let coinListCachedAt = 0;
let coinListPromise = null;

export function resetCoinPaprikaCache() {
  priceCache.clear();
  slugToId = null;
  coinListCachedAt = 0;
  coinListPromise = null;
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

async function getSlugToId() {
  if (slugToId && Date.now() - coinListCachedAt < COIN_LIST_TTL_MS) return slugToId;
  if (!coinListPromise) {
    coinListPromise = fetchJsonWithRetry('https://api.coinpaprika.com/v1/coins')
      .then((coins) => {
        const map = new Map();
        for (const coin of coins) {
          if (!coin.is_active) continue;
          const dashIndex = coin.id.indexOf('-');
          const slug = dashIndex === -1 ? coin.id : coin.id.slice(dashIndex + 1);
          const rank = coin.rank || Infinity;
          const existing = map.get(slug);
          if (!existing || rank < existing.rank) map.set(slug, { id: coin.id, rank });
        }
        slugToId = map;
        coinListCachedAt = Date.now();
        return map;
      })
      .finally(() => {
        coinListPromise = null;
      });
  }
  return coinListPromise;
}

// Returns { priceUsd, symbol, marketCapUsd, change24hPct, asOfUnix } for a
// CoinGecko-style coin_id (e.g. "bitcoin"), or throws
// CoinPaprikaNotFoundError if no active CoinPaprika asset matches that
// slug. Any other failure throws a plain Error, same convention as
// coinGeckoApi.js — callers should treat that as "try another source".
export async function getCoinPaprikaPrice(coinId) {
  const cached = priceCache.get(coinId);
  if (cached && Date.now() - cached.storedAt < PRICE_CACHE_TTL_MS) return cached.value;

  const map = await getSlugToId();
  const entry = map.get(coinId.toLowerCase());
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
