// Twelve Data is the primary source. Yahoo remains a fallback so a temporary
// provider failure does not make the endpoint unavailable.

import { getTwelveDataStockQuote, TwelveDataTickerNotFoundError } from './twelveDataApi.js';
import { getStockQuote as getYahooStockQuote, TickerNotFoundError as YahooTickerNotFoundError } from './yahooFinanceApi.js';

export class TickerNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TickerNotFoundError';
  }
}

export async function getStockQuote(ticker) {
  const errors = [];

  if (process.env.TWELVE_DATA_API_KEY) {
    try {
      return await getTwelveDataStockQuote(ticker);
    } catch (err) {
      errors.push(err);
    }
  }

  try {
    const quote = await getYahooStockQuote(ticker);
    return { ...quote, source: 'yahoo_finance' };
  } catch (err) {
    errors.push(err);
  }

  if (errors.every((err) => err instanceof TwelveDataTickerNotFoundError || err instanceof YahooTickerNotFoundError)) {
    throw new TickerNotFoundError(`no stock quote found for '${ticker}'`);
  }

  throw new Error(errors.map((err) => err.message).join('; '));
}
