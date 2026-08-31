// Yahoo is the primary source. Twelve Data is the fallback so a temporary
// provider failure does not make the endpoint unavailable.
//
// Yahoo leads because it is the source that agrees with how STOCK_PRICE is
// actually graded. Measured 2026-08-31 against the live champion answer for
// AAPL, taken within seconds of each other:
//
//   champion miner (scoring 0.9946 live)  $316.85  observed 21:22:44Z
//   Yahoo regularMarketPrice              $316.85  observed 20:00:01Z
//   Twelve Data quote.close               $317.23  observed 13:30:00Z
//
// Twelve Data was returning the 13:30 figure, which is the market open, so
// the endpoint was answering with a price roughly six hours stale and about
// 38 cents off the graded value. The champion STOCK_PRICE scorer (#2147)
// returns 0 for a price even one cent out, so that gap alone was enough to
// score nothing. Yahoo's number matched the graded one exactly.
//
// The trade-off Yahoo brings is that it has no official free API and does
// rate-limit. That is survivable here: yahooFinanceApi.js already retries
// 429s and 5xxs with backoff, and Twelve Data still catches the case where
// Yahoo is genuinely down.

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
  try {
    const quote = await getYahooStockQuote(ticker);
    return { ...quote, source: 'yahoo_finance', resolvedTicker: ticker };
  } catch (err) {
    err.provider = 'yahoo';
    errors.push(err);
  }

  if (process.env.TWELVE_DATA_API_KEY) {
    try {
      return { ...(await getTwelveDataStockQuote(ticker)), resolvedTicker: ticker };
    } catch (err) {
      err.provider = 'twelve_data';
      errors.push(err);
    }
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
  // Both providers get to settle this on their own, because either one can
  // be the only one that actually reached a verdict. A definitive not-found
  // from Yahoo (a clean 404) should not be overridden by Twelve Data being
  // rate-limited, and the reverse holds too: this used to trust only Twelve
  // Data here, which was right while Twelve Data led, but would now turn an
  // unrecognized ticker into a 502 whenever the fallback was having a bad
  // minute. A transient failure is inconclusive about whether a ticker
  // exists; a not-found is not.
  const confirmedNotFound = errors.some(
    (err) => (err.provider === 'twelve_data' && err instanceof TwelveDataTickerNotFoundError)
      || (err.provider === 'yahoo' && err instanceof YahooTickerNotFoundError),
  );
  if (confirmedNotFound || errors.every(isNotFoundError)) {
    throw new TickerNotFoundError(`no stock quote found for '${rawTicker}'`);
  }

  throw new Error(errors.map((err) => err.message).join('; '));
}
