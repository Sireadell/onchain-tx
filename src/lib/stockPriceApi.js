// Twelve Data is the primary source. Yahoo remains a fallback so a temporary
// provider failure does not make the endpoint unavailable.

import { getTwelveDataStockQuote, TwelveDataTickerNotFoundError, searchTwelveDataSymbol } from './twelveDataApi.js';
import { getStockQuote as getYahooStockQuote, TickerNotFoundError as YahooTickerNotFoundError } from './yahooFinanceApi.js';

export class TickerNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TickerNotFoundError';
  }
}

function isNotFoundError(err) {
  return err instanceof TwelveDataTickerNotFoundError || err instanceof YahooTickerNotFoundError;
}

// Tries both providers with the given ticker as typed. Returns the quote
// with a `resolvedTicker` field, or null if neither succeeded — pushing
// every failure onto `errors`, not just "not found" ones. A transient
// failure from one provider (rate limit, timeout) must not stop this from
// still attempting name resolution below: a real 429 from Yahoo isn't
// evidence the ticker is unresolvable, and aborting here on it would
// skip the search-and-retry step entirely for an input that search could
// have fixed. The caller classifies the collected errors once, after
// every attempt (direct and resolved) is exhausted.
async function tryQuote(ticker, errors) {
  if (process.env.TWELVE_DATA_API_KEY) {
    try {
      return { ...(await getTwelveDataStockQuote(ticker)), resolvedTicker: ticker };
    } catch (err) {
      err.provider = 'twelve_data';
      errors.push(err);
    }
  }

  try {
    const quote = await getYahooStockQuote(ticker);
    return { ...quote, source: 'yahoo_finance', resolvedTicker: ticker };
  } catch (err) {
    err.provider = 'yahoo';
    errors.push(err);
  }

  return null;
}

// Tries the ticker exactly as given first — most callers already send a
// real symbol (AAPL, MSFT), and a symbol search round-trip would only add
// latency there. Only when that fails does this attempt to resolve it as
// a company name or loosely-typed query via Twelve Data's symbol search
// and retry once. Live-checked 2026-08-29: "ticker=Apple" reached both
// providers unresolved and failed each in a shape neither's not-found
// detection caught, producing a 502 on what was really just an
// unrecognized company name — this both fixes that shape-detection gap
// (see twelveDataApi.js) and actually resolves the name to AAPL.
export async function getStockQuote(rawTicker) {
  const errors = [];

  const direct = await tryQuote(rawTicker, errors);
  if (direct) return direct;

  const resolved = await searchTwelveDataSymbol(rawTicker);
  if (resolved && resolved.toUpperCase() !== rawTicker.toUpperCase()) {
    const viaSearch = await tryQuote(resolved, errors);
    if (viaSearch) return viaSearch;
  }

  // Live-checked 2026-08-29: a garbage ticker while Yahoo happened to be
  // rate-limited (429) produced neither `errors.every(isNotFoundError)` —
  // Yahoo's 429 isn't a not-found error — nor a real quote, so this fell
  // through to a generic 502 on what was really just an unrecognized
  // ticker. A 429 from the fallback provider is inconclusive about
  // whether the ticker exists, not evidence that it does, so it shouldn't
  // be able to override a definitive not-found verdict from Twelve Data
  // (the primary source). Trust that verdict on its own.
  const twelveDataConfirmedNotFound = errors.some(
    (err) => err.provider === 'twelve_data' && err instanceof TwelveDataTickerNotFoundError,
  );
  if (twelveDataConfirmedNotFound || errors.every(isNotFoundError)) {
    throw new TickerNotFoundError(`no stock quote found for '${rawTicker}'`);
  }

  throw new Error(errors.map((err) => err.message).join('; '));
}
