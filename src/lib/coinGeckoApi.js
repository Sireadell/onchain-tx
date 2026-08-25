// CoinGecko public API transport, used only by CRYPTO_PRICE's coin_id mode
// as a fresher primary source than DefiLlama's coins.llama.fi proxy.
// Compared live 2026-08-25: DefiLlama's cached price for a coin_id was
// consistently ~1-2 minutes staler than querying CoinGecko directly (its
// own cache sits in front of CoinGecko, adding a second staleness layer).
// For a fast-moving price, that gap plausibly explains losing to other
// miners on "closest to the real number" grading even when our answer was
// technically correct. No API key required for this endpoint.
//
// Deliberately narrow: only coin_id lookups. The chain_token mode (price of
// a specific on-chain token by contract address) stays on DefiLlama —
// CoinGecko's free tier token-price endpoint isn't the same shape and this
// wasn't the mode we saw actually graded.

import { checkBudget } from './ankrRpc.js';

const COINGECKO_CALL_TIMEOUT_MS = Number(process.env.COINGECKO_CALL_TIMEOUT_MS) || 5_000;
const RETRY_DELAYS_MS = [500, 1_000];

export class CoinGeckoNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoinGeckoNotFoundError';
  }
}

function isRetryableFailure(statusCode, errName) {
  if (errName === 'AbortError') return true;
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500) return true;
  return false;
}

// Returns { priceUsd, asOfUnix } for a CoinGecko coin id (e.g. "bitcoin"),
// or throws CoinGeckoNotFoundError if CoinGecko doesn't recognize the id.
// Any other failure (timeout, rate limit after retries, network error)
// throws a plain Error — callers should treat that as "try the fallback
// source", not "this coin doesn't exist".
export async function getCoinGeckoPrice(coinId) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    checkBudget();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COINGECKO_CALL_TIMEOUT_MS);
    let res;
    let ok = true;
    let statusCode;
    let errName;
    let networkErr;
    try {
      res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd&include_last_updated_at=true`,
        { signal: controller.signal }
      );
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
      const body = await res.json();
      const entry = body?.[coinId];
      if (!entry || typeof entry.usd !== 'number') {
        throw new CoinGeckoNotFoundError(`no CoinGecko price found for '${coinId}'`);
      }
      return { priceUsd: entry.usd, asOfUnix: entry.last_updated_at ?? null };
    }

    const retryable = isRetryableFailure(statusCode, errName);
    const attemptsLeft = attempt < RETRY_DELAYS_MS.length;
    if (!retryable || !attemptsLeft) {
      if (errName === 'AbortError') {
        throw new Error(`CoinGecko request timed out after ${COINGECKO_CALL_TIMEOUT_MS}ms (${attempt + 1} attempt(s))`);
      }
      if (networkErr) throw networkErr;
      throw new Error(`CoinGecko request failed: ${statusCode} ${res.statusText} (${attempt + 1} attempt(s))`);
    }

    const base = RETRY_DELAYS_MS[attempt];
    const jitteredDelay = base * (0.7 + Math.random() * 0.6);
    await new Promise((r) => setTimeout(r, jitteredDelay));
  }
}
