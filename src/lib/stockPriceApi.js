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
// with a `resolvedTicker` field, or null if both providers say "not
// found" (pushing their errors onto `errors` for the caller to inspect).
// A genuine outage (timeout, 5xx, rate limit) is NOT swallowed here — it
// is re-thrown immediately, since that's our fault, not the caller's, and
// should not be masked by a resolution retry.
async function tryQuote(ticker, errors) {
  if (process.env.TWELVE_DATA_API_KEY) {
    try {
      return { ...(await getTwelveDataStockQuote(ticker)), resolvedTicker: ticker };
    } catch (err) {
      if (!(err instanceof TwelveDataTickerNotFoundError)) throw err;
      errors.push(err);
    }
  }

  try {
    const quote = await getYahooStockQuote(ticker);
    return { ...quote, source: 'yahoo_finance', resolvedTicker: ticker };
  } catch (err) {
    if (!(err instanceof YahooTickerNotFoundError)) throw err;
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

  if (errors.every(isNotFoundError)) {
    throw new TickerNotFoundError(`no stock quote found for '${rawTicker}'`);
  }

  throw new Error(errors.map((err) => err.message).join('; '));
}
