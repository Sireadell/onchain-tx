// FX_NOW signal endpoint: the current mid-market rate between two
// currencies, optionally applied to an amount. Reads the question the same
// way /currency-exchange does, but from a feed covering 166 currencies.

import { Router } from 'express';
import { liveFxRate } from '../lib/fxNow.js';
import { CurrencyLookupError, CurrencyUpstreamError } from '../lib/currencyExchange.js';
import { parseCurrencyParams } from './checkCurrencyExchange.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';

const router = Router();

function formatNumber(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 4 });
}

function summarize({ from, to, amount, rate, result, asOf, source }) {
  const when = asOf.slice(0, 16).replace('T', ' ');
  const lead = amount === 1
    ? `1 ${from} = ${formatNumber(rate)} ${to}`
    : `${formatNumber(amount)} ${from} = ${formatNumber(result)} ${to}`;
  const inverse = rate > 0 ? ` (1 ${to} = ${formatNumber(1 / rate)} ${from})` : '';
  return `${lead} at the current mid-market rate of ${formatNumber(rate)}${inverse}, as of ${when} UTC, from ${source}.`;
}

async function handleFxNow(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const { from, to, amount } = parseCurrencyParams(params);

  if (!from || !to) {
    return respondUnusableInput(
      res,
      from
        ? `I found a source currency (${quoteParam(from)}) but no target currency. Pass to as a currency code such as EUR.`
        : 'I cannot quote an exchange rate because no currency pair was supplied. Pass from and to as currency codes (e.g. from=USD, to=EUR) or name them in the question, e.g. "USD to EUR right now".',
    );
  }

  const finalAmount = Number.isFinite(amount) && amount >= 0 ? amount : 1;

  let quote;
  try {
    quote = await liveFxRate(from, to, finalAmount);
  } catch (err) {
    if (err instanceof CurrencyLookupError) {
      return respondUnusableInput(res, `${quoteParam(`${from}/${to}`)} is not a pair any live FX feed publishes. ${err.message}.`);
    }
    if (err instanceof CurrencyUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: `The live FX rate feeds are temporarily unavailable for ${from} to ${to}. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  res.json({
    status: 'ok',
    summary: summarize(quote),
    confidence: quote.source.startsWith('ECB') ? 0.8 : 0.9,
    canonical: ['fx-now', quote.from, quote.to].join(':'),
    base: quote.from,
    quote: quote.to,
    from: quote.from,
    to: quote.to,
    amount: quote.amount,
    rate: quote.rate,
    inverse_rate: quote.rate > 0 ? Number((1 / quote.rate).toFixed(8)) : null,
    result: quote.result,
    as_of: quote.asOf,
    source: quote.source,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleFxNow(req, res));
router.post('/', (req, res) => handleFxNow(req, res));

export default router;
