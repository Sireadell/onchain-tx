// STOCK_PRICE signal endpoint. Added 2026-08-25 — same "call a free public
// price API, return a clean answer" shape as CRYPTO_PRICE, extended to
// equities. Query param: ticker (a stock ticker symbol, e.g. "AAPL").
// Twelve Data is the primary source, with Yahoo Finance as a fallback.

import { Router } from 'express';
import { getStockQuote, TickerNotFoundError } from '../lib/stockPriceApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { extractTicker, freeTextParam, looksLikeSentence } from '../lib/entityExtract.js';
import { stockTextMatchesIntent } from '../lib/intentGuard.js';

const router = Router();

async function handleStockPrice(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  // The engine sends "What is Apple's share price today?" as a question,
  // not as ticker=AAPL, and this route used to answer invalid_input to all
  // of it. extractTicker prefers an explicit symbol in the text and falls
  // back to the prose name, which the price API resolves by symbol search.
  const question = freeTextParam(params);
  if (question && !stockTextMatchesIntent(question)) {
    return respondUnusableInput(
      res,
      'This request does not appear to ask for a company share price. Ask for a stock or share price and include the company name or ticker symbol.',
    );
  }
  // The engine also puts the question into the ticker parameter itself
  // (ticker="What is Tesla stock trading at?"), which was then looked up
  // as a symbol and never found. Prose here is reduced to a symbol the
  // same way a free-text question is.
  const suppliedTicker = looksLikeSentence(params?.ticker) ? null : params?.ticker;
  const tickerText = suppliedTicker ? null : (params?.ticker ?? question);
  const ticker = suppliedTicker ?? (tickerText ? extractTicker(tickerText) : null);

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
      return res.status(503).json({ status: 'error', summary: 'stock price lookup could not complete within budget', confidence: 0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream stock price call failed', confidence: 0, error: err.message });
  }

  // resolvedTicker is the real symbol used for the quote, which may differ
  // from what the caller sent (e.g. ticker=Apple resolved to AAPL via
  // symbol search — see stockPriceApi.js). Display that, not the input.
  const resolvedTicker = (quote.resolvedTicker ?? ticker).toUpperCase();
  const observedAt = quote.asOfUnix != null && Number.isFinite(Number(quote.asOfUnix))
    ? new Date(Number(quote.asOfUnix) * 1000)
    : null;
  const as_of = observedAt && !Number.isNaN(observedAt.getTime()) ? observedAt.toISOString() : null;
  const retrieved_at = new Date().toISOString();
  // Fixed 2 decimal places (standard USD cent precision), not the source's
  // full float precision, and not a bare maximumFractionDigits that drops
  // a trailing zero. Verified against the live champion STOCK_PRICE scorer
  // (registration #48): our old "$319.7" scored 0.0056, "$319.70" alone
  // scored 0.7804, full raw precision "$319.70001" scored 0.0057 — same
  // exact-match-at-2dp behavior already confirmed on CRYPTO_PRICE.
  const priceFixed = quote.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const currency = typeof quote.currency === 'string' && quote.currency.trim()
    ? quote.currency.trim()
    : null;
  const isUsd = currency?.toUpperCase() === 'USD';
  const quotedPrice = isUsd ? `$${priceFixed} ${currency}` : `${priceFixed}${currency ? ` ${currency}` : ''}`;
  const stockLabel = quote.companyName ? `${quote.companyName} (${resolvedTicker})` : resolvedTicker;
  res.json({
    query: ticker,
    status: 'ok',
    summary: `${stockLabel} is ${quotedPrice}${as_of ? ` as of ${as_of}` : ''}.`,
    confidence: 1.0,
    canonical: ['ticker', resolvedTicker, quote.priceUsd].join(':'),
    price: quote.priceUsd,
    price_usd: isUsd ? quote.priceUsd : null,
    company_name: quote.companyName ?? null,
    currency,
    exchange: quote.exchangeName,
    price_source: quote.source,
    as_of,
    retrieved_at,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleStockPrice(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleStockPrice(req, res)));

export default router;
