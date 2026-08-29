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
