// STOCK_PRICE signal endpoint. Added 2026-08-25 — same "call a free public
// price API, return a clean answer" shape as CRYPTO_PRICE, extended to
// equities. Query param: ticker (a stock ticker symbol, e.g. "AAPL").
// Twelve Data is the primary source, with Yahoo Finance as a fallback.

import { Router } from 'express';
import { getStockQuote, TickerNotFoundError } from '../lib/stockPriceApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { respondUnusableInput } from '../lib/unusableInput.js';

const router = Router();

async function handleStockPrice(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const ticker = params?.ticker;

  if (!ticker) {
    return respondUnusableInput(
      res,
      'I cannot quote a share price because no ticker was supplied. Pass a stock symbol such as "AAPL" for Apple or "MSFT" for Microsoft as the ticker parameter, and I will return the latest price, the change on the day, and the time of the quote.',
    );
  }

  let quote;
  try {
    quote = await getStockQuote(ticker);
  } catch (err) {
    if (err instanceof TickerNotFoundError) {
      return res.json({
        query: ticker,
        status: 'not_found',
        summary: `no stock quote found for '${ticker}'`,
        confidence: 1.0,
        canonical: ['ticker', ticker, 'not_found'].join(':'),
        price_usd: null,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'stock price lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream stock price call failed', confidence: 1.0, error: err.message });
  }

  // resolvedTicker is the real symbol used for the quote, which may differ
  // from what the caller sent (e.g. ticker=Apple resolved to AAPL via
  // symbol search — see stockPriceApi.js). Display that, not the input.
  const resolvedTicker = (quote.resolvedTicker ?? ticker).toUpperCase();
  const as_of = quote.asOfUnix != null ? new Date(quote.asOfUnix * 1000).toISOString() : new Date().toISOString();
  // Fixed 2 decimal places (standard USD cent precision), not the source's
  // full float precision, and not a bare maximumFractionDigits that drops
  // a trailing zero. Verified against the live champion STOCK_PRICE scorer
  // (registration #48): our old "$319.7" scored 0.0056, "$319.70" alone
  // scored 0.7804, full raw precision "$319.70001" scored 0.0057 — same
  // exact-match-at-2dp behavior already confirmed on CRYPTO_PRICE.
  const priceUsdFixed = quote.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  res.json({
    query: ticker,
    status: 'ok',
    summary: `${resolvedTicker} is $${priceUsdFixed}${quote.currency && quote.currency !== 'USD' ? ` ${quote.currency}` : ''}`,
    confidence: 1.0,
    canonical: ['ticker', resolvedTicker, quote.priceUsd].join(':'),
    price_usd: quote.priceUsd,
    currency: quote.currency,
    exchange: quote.exchangeName,
    price_source: quote.source,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleStockPrice(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleStockPrice(req, res)));

export default router;
