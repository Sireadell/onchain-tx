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

// Historical closing price for a past day, the fallback behind Twelve Data
// for the historical side of STOCK_PRICE. Yahoo's chart endpoint takes a
// unix range and returns one bar per trading day, so the same
// "last session on or before the day asked about" rule applies here as
// there: weekends and market holidays have no bar of their own.
const HISTORICAL_WINDOW_DAYS = 10;

export async function getYahooHistoricalClose(ticker, isoDay) {
  checkBudget();
  const end = new Date(`${isoDay}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(`${isoDay}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - HISTORICAL_WINDOW_DAYS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`);
    url.searchParams.set('period1', String(Math.floor(start.getTime() / 1000)));
    url.searchParams.set('period2', String(Math.floor(end.getTime() / 1000)));
    url.searchParams.set('interval', '1d');
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Yahoo Finance request timed out after ${CALL_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    throw new TickerNotFoundError(`no Yahoo Finance history found for '${ticker}'`);
  }
  if (res.status !== 200) {
    throw new Error(`Yahoo Finance request failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.json().catch(() => null);
  const result = body?.chart?.result?.[0];
  const stamps = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];

  // Walk back from the newest bar to the first one that is a real close on
  // or before the day asked about. Yahoo can return a null close for a
  // half-formed bar, which must not be read as a price of zero.
  let bar = null;
  for (let i = stamps.length - 1; i >= 0; i--) {
    const day = new Date(stamps[i] * 1000).toISOString().slice(0, 10);
    const close = Number(closes[i]);
    if (day <= isoDay && Number.isFinite(close) && close > 0) {
      bar = { close, day };
      break;
    }
  }
  if (!bar) {
    throw new TickerNotFoundError(`no Yahoo Finance history found for '${ticker}' on or before ${isoDay}`);
  }

  return {
    priceUsd: bar.close,
    companyName: result?.meta?.longName ?? result?.meta?.shortName ?? null,
    currency: result?.meta?.currency ?? null,
    exchangeName: result?.meta?.fullExchangeName ?? result?.meta?.exchangeName ?? null,
    tradingDay: bar.day,
    source: 'yahoo_finance',
  };
}
