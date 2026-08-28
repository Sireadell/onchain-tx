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

  const as_of = quote.asOfUnix != null ? new Date(quote.asOfUnix * 1000).toISOString() : new Date().toISOString();
  res.json({
    query: ticker,
    status: 'ok',
    summary: `${ticker.toUpperCase()} is $${quote.priceUsd.toLocaleString('en-US', { maximumFractionDigits: 4 })}${quote.currency && quote.currency !== 'USD' ? ` ${quote.currency}` : ''}`,
    confidence: 1.0,
    canonical: ['ticker', ticker.toUpperCase(), quote.priceUsd].join(':'),
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
