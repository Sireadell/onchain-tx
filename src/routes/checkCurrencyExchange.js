// CURRENCY_EXCHANGE signal endpoint. Given an amount and two currencies,
// converts one to the other using live ECB reference rates (Frankfurter,
// lib/currencyExchange.js). Params seen on competing miners in the live
// registry (2026-09-17): from/to (fx-rate-mirror), base/symbols
// (fxex-frankfurter-jpy), amount, plus full currency names ("dollars",
// "euros") rather than codes.

import { Router } from 'express';
import {
  convertCurrency, resolveCurrencyCode, isKnownCurrency,
  CurrencyLookupError, CurrencyUpstreamError,
} from '../lib/currencyExchange.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

// Every alias a competing miner on this intent declares, plus the plain
// ones this route documents itself.
const FROM_KEYS = ['from', 'base', 'source', 'source_currency', 'from_currency', 'currency'];
const TO_KEYS = ['to', 'symbols', 'target', 'target_currency', 'to_currency', 'quote_currency', 'vs_currencies', 'vs_currency'];
const AMOUNT_KEYS = ['amount', 'value', 'quantity', 'sum'];
const QUESTION_KEYS = ['question', 'query', 'q', 'text', 'input'];

const MAX_INPUT_CHARS = 500;

// Pulls "100 USD to EUR", "convert 50 dollars to euros", "EUR/USD",
// "1 pound in yen" out of a whole question when no structured from/to
// arrived. Deliberately narrow: two currency-shaped tokens joined by a
// connector word, with an optional leading number.
// The bare-code alternative is word-bounded (\b...\b) so it can only match a
// standalone three-letter token, never the first three letters of a longer
// word. Found live 2026-09-17: without the boundary, "to British pounds"
// matched the target as "BRI" (the first three letters of "British"), an
// unrecognized code, instead of failing to match "British" at all and
// falling through to a currency name that actually appears, "pounds".
// CURRENCY_TERM also gets an optional adjective (american/british/us/uk/
// swiss/...) in front of the bare name, since "British pounds" and "US
// dollars" are exactly how people phrase this, not "GBP" or "USD".
const CURRENCY_WORD = 'dollars?|euros?|pounds?|yen|yuan|rmb|renminbi|francs?|rupees?|won|rand|reais?|pesos?|kronor?|kroner?|zloty|lira|shekels?|ringgit|baht|rupiah|forint|naira';
// EITHER a bare three-letter code standing alone ("USD"), OR an optional
// adjective followed by a named currency word ("British pounds", "dollars").
// Building this as one alternative feeding into the other was the bug:
// making the 3-letter code a PREFIX that still required a currency word
// straight after it meant a bare code alone ("USD to INR") could never
// complete the pattern at all, breaking the single most common phrasing.
const CURRENCY_TERM = `(?:\\b[A-Za-z]{3}\\b|(?:(?:american|british|us|u\\.s\\.|uk|swiss|canadian|australian|mexican|indian|japanese|chinese)\\s+)?(?:${CURRENCY_WORD}))`;
const PAIR_RE = new RegExp(`(-?\\d[\\d,.]*)?\\s*(${CURRENCY_TERM})\\s+(?:to|in|into|vs\\.?|versus|\\/|per|for)\\s+(${CURRENCY_TERM})`, 'i');

// "How many pesos is 100 dollars?" / "How much is 50 GBP in USD", the
// amount sits with the SECOND currency, not the first, and the connector is
// "is", not the to/in/into family PAIR_RE looks for. Found live 2026-09-17:
// this exact phrasing refused for want of a currency pair even though both
// currencies and the amount are right there.
const REVERSE_PAIR_RE = new RegExp(`\\b(?:how\\s+(?:many|much)\\s+)?(${CURRENCY_TERM})\\s+(?:is|are)\\s+(-?\\d[\\d,.]*)\\s*(${CURRENCY_TERM})`, 'i');

// "what's the fx rate of euro", "how much is one euro worth", only one
// currency named at all. Frankfurter's own default base is USD, so a
// single named currency is read as "X to USD", the same assumption most
// plain-English fx questions make when they do not name a second currency.
// Deliberately excludes CURRENCY_TERM's bare-three-letter-code alternative:
// found live 2026-09-17, scanning a whole sentence for ANY bare three-letter
// word matched "the" in "what's the fx rate of euro?" before ever reaching
// "euro", since ordinary English is full of three-letter words. PAIR_RE
// does not have this problem because it also requires a connector word
// between two such terms; a lone scan has no such anchor.
const SINGLE_CURRENCY_TERM = `(?:(?:american|british|us|u\\.s\\.|uk|swiss|canadian|australian|mexican|indian|japanese|chinese)\\s+)?(?:${CURRENCY_WORD})`;
const SINGLE_CURRENCY_RE = new RegExp(`\\b(${SINGLE_CURRENCY_TERM})\\b`, 'i');

function extractFromQuestion(text) {
  const match = text.match(PAIR_RE);
  if (match) {
    const from = resolveCurrencyCode(match[2]);
    const to = resolveCurrencyCode(match[3]);
    if (from && to) return { from, to, amount: match[1] ? Number(match[1].replace(/,/g, '')) : undefined };
  }
  const reverse = text.match(REVERSE_PAIR_RE);
  if (reverse) {
    const to = resolveCurrencyCode(reverse[1]);
    const from = resolveCurrencyCode(reverse[3]);
    if (from && to) return { from, to, amount: Number(reverse[2].replace(/,/g, '')) };
  }
  const single = text.match(SINGLE_CURRENCY_RE);
  if (single) {
    const from = resolveCurrencyCode(single[1]);
    if (from && from !== 'USD') return { from, to: 'USD', amount: undefined };
  }
  return null;
}

function summarize({
  from, to, amount, rate, result, date,
}) {
  const amtText = amount === 1 ? '1' : amount.toLocaleString('en-US', { maximumFractionDigits: 6 });
  const resultText = result.toLocaleString('en-US', { maximumFractionDigits: 6 });
  return `${amtText} ${from} is worth ${resultText} ${to} at the ECB reference rate as of ${date} (1 ${from} = ${rate} ${to}).`;
}

async function handleCurrencyExchange(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  const fromRaw = firstUsableValue(...FROM_KEYS.map((k) => params[k]));
  const toRaw = firstUsableValue(...TO_KEYS.map((k) => params[k]));
  const amountRaw = firstUsableValue(...AMOUNT_KEYS.map((k) => params[k]));
  const questionRaw = firstUsableValue(...QUESTION_KEYS.map((k) => params[k]));

  let from = typeof fromRaw === 'string' ? resolveCurrencyCode(fromRaw) : null;
  let to = typeof toRaw === 'string' ? resolveCurrencyCode(toRaw) : null;
  let amount = amountRaw !== undefined ? Number(amountRaw) : undefined;

  if ((!from || !to) && typeof questionRaw === 'string' && questionRaw.trim()) {
    const derived = extractFromQuestion(questionRaw.slice(0, MAX_INPUT_CHARS));
    if (derived) {
      from = from ?? derived.from;
      to = to ?? derived.to;
      if (amount === undefined) amount = derived.amount;
    }
  }

  if (!from && !to) {
    return respondUnusableInput(
      res,
      'I cannot convert a currency because no source and target currency were supplied. Pass from and to as currency codes (e.g. from=USD, to=EUR) or name them in the question, e.g. "100 dollars to euros".',
    );
  }
  if (!from) {
    return respondUnusableInput(res, `I found a target currency but no source currency to convert from. Pass a from currency code such as USD.`);
  }
  if (!to) {
    return respondUnusableInput(res, `I found a source currency (${quoteParam(from)}) but no target currency to convert to. Pass a to currency code such as EUR.`);
  }
  if (!isKnownCurrency(from)) {
    return respondUnusableInput(
      res,
      `${quoteParam(from)} is not a currency the ECB reference rate feed publishes. This covers major world fiat currencies (USD, EUR, GBP, JPY, and similar); it does not cover cryptocurrencies or unlisted currencies.`,
    );
  }
  if (!isKnownCurrency(to)) {
    return respondUnusableInput(
      res,
      `${quoteParam(to)} is not a currency the ECB reference rate feed publishes. This covers major world fiat currencies (USD, EUR, GBP, JPY, and similar); it does not cover cryptocurrencies or unlisted currencies.`,
    );
  }

  const finalAmount = Number.isFinite(amount) && amount >= 0 ? amount : 1;

  let conversion;
  try {
    conversion = await convertCurrency(from, to, finalAmount);
  } catch (err) {
    if (err instanceof CurrencyLookupError) {
      return respondUnusableInput(res, err.message);
    }
    if (err instanceof CurrencyUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: `The currency exchange rate provider is temporarily unavailable for ${from} to ${to}. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  res.json({
    status: 'ok',
    summary: summarize(conversion),
    confidence: 0.9,
    canonical: ['currency-exchange', conversion.from, conversion.to].join(':'),
    from: conversion.from,
    to: conversion.to,
    amount: conversion.amount,
    rate: conversion.rate,
    result: conversion.result,
    rate_date: conversion.date,
    source: conversion.source,
    checked_at: conversion.fetchedAt,
  });
}

router.get('/', (req, res) => handleCurrencyExchange(req, res));
router.post('/', (req, res) => handleCurrencyExchange(req, res));

export default router;
