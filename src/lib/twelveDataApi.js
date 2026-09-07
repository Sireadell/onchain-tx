// Official Twelve Data stock quote API. This is the primary STOCK_PRICE
// source when TWELVE_DATA_API_KEY is configured.

import { checkBudget } from './ankrRpc.js';

const CALL_TIMEOUT_MS = Number(process.env.TWELVE_DATA_CALL_TIMEOUT_MS) || 5_000;

export class TwelveDataTickerNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TwelveDataTickerNotFoundError';
  }
}

export async function getTwelveDataStockQuote(ticker) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY is not configured');

  checkBudget();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  let res;
  try {
    const url = new URL('https://api.twelvedata.com/quote');
    url.searchParams.set('symbol', ticker);
    url.searchParams.set('apikey', apiKey);
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Twelve Data request timed out after ${CALL_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status === 'error') {
    const message = body?.message ?? `${res.status} ${res.statusText}`;
    // "missing or invalid" is what Twelve Data actually says for an
    // unrecognized symbol (confirmed live 2026-08-29 with ticker=Apple) —
    // the earlier pattern only matched a differently-worded not-found
    // message and let this fall through to a generic Error, which
    // produced a 502 on ordinary bad input instead of a graceful answer.
    if (/not found|invalid symbol|symbol.*exist|missing or invalid/i.test(message)) {
      throw new TwelveDataTickerNotFoundError(`no Twelve Data quote found for '${ticker}'`);
    }
    throw new Error(`Twelve Data request failed: ${message}`);
  }

  const price = Number(body?.close);
  if (!Number.isFinite(price) || price <= 0) {
    throw new TwelveDataTickerNotFoundError(`no Twelve Data quote found for '${ticker}'`);
  }

  return {
    priceUsd: price,
    companyName: body.name ?? null,
    currency: body.currency ?? 'USD',
    exchangeName: body.exchange ?? null,
    asOfUnix: Number.isFinite(Number(body.timestamp)) ? Number(body.timestamp) : null,
    source: 'twelve_data',
  };
}

// Resolves a company name or loosely-typed query ("Apple", "apple stock")
// to a real ticker symbol via Twelve Data's symbol_search, for callers
// upstream that only try this when the input doesn't already look like a
// clean ticker (see stockPriceApi.js). Best-effort: returns null on any
// failure (no key configured, network error, no match) rather than
// throwing, since a failed search should fall through to the existing
// not-found handling, not turn into a hard error of its own.
export async function searchTwelveDataSymbol(query) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return null;

  try {
    checkBudget();
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const url = new URL('https://api.twelvedata.com/symbol_search');
    url.searchParams.set('symbol', query);
    url.searchParams.set('apikey', apiKey);
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const best = body?.data?.[0];
    return typeof best?.symbol === 'string' ? best.symbol : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns the closing price on a past day, for the historical side of
// STOCK_PRICE. Markets shut at weekends and on holidays, so this asks for a
// window ending on the requested day and takes the most recent session in
// it: 2024-01-15 was Martin Luther King Day and has no bar of its own, but
// the honest answer to "what was NVDA worth on the 15th" is the last close
// standing on that day, not a refusal.
//
// Live-checked 2026-09-07: time_series for NVDA over 2024-01-15..20 came
// back with the 16th through the 19th and no 15th, exactly as expected.
const HISTORICAL_WINDOW_DAYS = 10;

export async function getTwelveDataHistoricalClose(ticker, isoDay) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY is not configured');

  checkBudget();
  const startDate = new Date(`${isoDay}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - HISTORICAL_WINDOW_DAYS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', ticker);
    url.searchParams.set('interval', '1day');
    url.searchParams.set('start_date', startDate.toISOString().slice(0, 10));
    // end_date is exclusive. Checked live 2026-09-07: asking for
    // end_date=2023-06-30, an ordinary Friday, returned the 29th and lost a
    // whole trading day, so this asks through the following day and the
    // filter below discards anything past the day that was requested.
    const endDate = new Date(`${isoDay}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    url.searchParams.set('end_date', endDate.toISOString().slice(0, 10));
    url.searchParams.set('order', 'DESC');
    url.searchParams.set('apikey', apiKey);
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Twelve Data request timed out after ${CALL_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status === 'error') {
    const message = body?.message ?? `${res.status} ${res.statusText}`;
    if (/not found|invalid symbol|symbol.*exist|missing or invalid|no data/i.test(message)) {
      throw new TwelveDataTickerNotFoundError(`no Twelve Data history found for '${ticker}'`);
    }
    throw new Error(`Twelve Data request failed: ${message}`);
  }

  // Values arrive newest first, and any bar dated after the requested day
  // would be a future price the asker never wanted.
  const bar = (body?.values ?? []).find((row) => typeof row?.datetime === 'string' && row.datetime.slice(0, 10) <= isoDay);
  const price = Number(bar?.close);
  if (!Number.isFinite(price) || price <= 0) {
    throw new TwelveDataTickerNotFoundError(`no Twelve Data history found for '${ticker}' on or before ${isoDay}`);
  }

  return {
    priceUsd: price,
    companyName: body?.meta?.name ?? null,
    currency: body?.meta?.currency ?? 'USD',
    exchangeName: body?.meta?.exchange ?? null,
    tradingDay: bar.datetime.slice(0, 10),
    source: 'twelve_data',
  };
}
