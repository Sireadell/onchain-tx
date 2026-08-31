// Yahoo Finance's public chart endpoint (query1.finance.yahoo.com) —
// undocumented but widely used, no API key required. Live-checked
// 2026-08-25: works from plain fetch with no custom User-Agent, returns a
// clean 404 with error.code "Not Found" for an unknown ticker (not a 200
// with an empty body), so "not found" is a real, cheap-to-detect case
// rather than something inferred from an empty response.
//
// This is the primary source for STOCK_PRICE, because its price is the one
// that matches how the intent is actually graded (see stockPriceApi.js for
// the measurement). Twelve Data backs it up when Yahoo is down or throttled,
// so a Yahoo outage no longer takes the endpoint offline the way it did when
// this was the only source.

import { checkBudget } from './ankrRpc.js';

const CALL_TIMEOUT_MS = Number(process.env.YAHOO_FINANCE_CALL_TIMEOUT_MS) || 5_000;
const RETRY_DELAYS_MS = [500, 1_000];

export class TickerNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TickerNotFoundError';
  }
}

function isRetryableFailure(statusCode, errName) {
  if (errName === 'AbortError') return true;
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500) return true;
  return false;
}

// Returns { priceUsd, currency, exchangeName, asOfUnix } for a ticker
// symbol (e.g. "AAPL"), or throws TickerNotFoundError.
export async function getStockQuote(ticker) {
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
      res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`, {
        signal: controller.signal,
      });
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
      const meta = body?.chart?.result?.[0]?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') {
        throw new TickerNotFoundError(`no Yahoo Finance quote found for '${ticker}'`);
      }
      return {
        priceUsd: meta.regularMarketPrice,
        companyName: meta.longName ?? meta.shortName ?? null,
        currency: meta.currency ?? null,
        exchangeName: meta.fullExchangeName ?? meta.exchangeName ?? null,
        asOfUnix: meta.regularMarketTime ?? null,
      };
    }

    if (statusCode === 404) {
      throw new TickerNotFoundError(`no Yahoo Finance quote found for '${ticker}'`);
    }

    const retryable = isRetryableFailure(statusCode, errName);
    const attemptsLeft = attempt < RETRY_DELAYS_MS.length;
    if (!retryable || !attemptsLeft) {
      if (errName === 'AbortError') {
        throw new Error(`Yahoo Finance request timed out after ${CALL_TIMEOUT_MS}ms (${attempt + 1} attempt(s))`);
      }
      if (networkErr) throw networkErr;
      throw new Error(`Yahoo Finance request failed: ${statusCode} ${res.statusText} (${attempt + 1} attempt(s))`);
    }

    const base = RETRY_DELAYS_MS[attempt];
    const jitteredDelay = base * (0.7 + Math.random() * 0.6);
    await new Promise((r) => setTimeout(r, jitteredDelay));
  }
}
