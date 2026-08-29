// CRYPTO_PRICE signal endpoint. Accepts either `coin_id` (a CoinGecko id,
// e.g. "bitcoin") or a `price_chain` + `token` pair (e.g.
// price_chain=ethereum, token=0xA0b8...eB48 for a specific on-chain token's
// price) — exactly one mode. `price_chain` is deliberately separate from
// `chain` (used by the other four endpoints) for the same reason as
// /tvl's `tvl_chain`: DefiLlama's chain namespace isn't restricted to our
// five-chain enum.
//
// coin_id mode queries CoinPaprika, CoinGecko, and DefiLlama's
// coins.llama.fi proxy concurrently and prefers whichever of the first two
// answers, in that order, over DefiLlama's cache. CoinPaprika is the
// primary source as of 2026-08-29: CoinGecko's free API returns 403 from
// Render's production IP (confirmed live), which silently nulled out
// market_cap_usd and change_24h_pct in every prod response even though
// the code for them was correct. CoinGecko stays in the race as a bonus
// source when it does work (local dev, other hosts) and DefiLlama remains
// the last-resort fallback. chain_token mode is unaffected — it stays on
// DefiLlama, the only source of the three that looks up a price by
// on-chain contract address at all.

import { Router } from 'express';
import { getCoinPrice, CoinNotFoundError } from '../lib/defiLlamaApi.js';
import { getCoinGeckoPrice } from '../lib/coinGeckoApi.js';
import { getCoinPaprikaPrice } from '../lib/coinPaprikaApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { quoteParam, respondUnusableInput } from '../lib/unusableInput.js';

// Tries all three sources at once; any failure (rate limit, blocked IP,
// timeout, unrecognized id) just drops that source rather than failing
// the whole request — a partial answer beats no answer. Preference order
// for which source's numbers to lead with: coinpaprika > coingecko >
// defillama.
async function getFreshestCoinPrice(coinId) {
  const [coinPaprika, coinGecko, defiLlama] = await Promise.allSettled([
    getCoinPaprikaPrice(coinId),
    getCoinGeckoPrice(coinId),
    getCoinPrice(`coingecko:${coinId}`),
  ]);
  if (coinPaprika.status === 'rejected' && coinGecko.status === 'rejected' && defiLlama.status === 'rejected') {
    throw defiLlama.reason;
  }

  const primary = coinPaprika.status === 'fulfilled'
    ? { ...coinPaprika.value, source: 'coinpaprika' }
    : coinGecko.status === 'fulfilled'
      ? { ...coinGecko.value, symbol: null, source: 'coingecko' }
      : { ...defiLlama.value, source: 'defillama' };

  const sources = [];
  if (coinPaprika.status === 'fulfilled') sources.push({ source: 'coinpaprika', price_usd: coinPaprika.value.priceUsd });
  if (coinGecko.status === 'fulfilled') sources.push({ source: 'coingecko', price_usd: coinGecko.value.priceUsd });
  if (defiLlama.status === 'fulfilled') sources.push({ source: 'defillama', price_usd: defiLlama.value.priceUsd });
  const prices = sources.map((item) => item.price_usd);
  return {
    ...primary,
    sources,
    sourceCount: sources.length,
    priceRangeLowUsd: prices.length ? Math.min(...prices) : primary.priceUsd,
    priceRangeHighUsd: prices.length ? Math.max(...prices) : primary.priceUsd,
  };
}

const router = Router();

const TOKEN_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function handleCryptoPrice(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const coinId = params?.coin_id;
  const priceChain = params?.price_chain;
  const token = params?.token;

  const chainTokenMode = Boolean(priceChain || token);
  if (!coinId && !chainTokenMode) {
    return respondUnusableInput(
      res,
      'I cannot quote a price because no coin was named. For a major coin, pass its id as the coin_id parameter, such as "bitcoin", "ethereum" or "solana". For any other token, pass its chain as price_chain and its contract address as token. Either way I will return the current price in USD.',
    );
  }
  if (coinId && chainTokenMode) {
    return respondUnusableInput(
      res,
      `I was asked for a price in two different ways at once: by coin id (${quoteParam(coinId)}) and by contract address. I can only follow one. Send coin_id on its own for a major coin, or price_chain and token together for a specific contract, and I will return the current USD price.`,
    );
  }
  if (chainTokenMode && (!priceChain || !token)) {
    const missing = priceChain ? 'the token contract address' : 'the chain it lives on';
    return respondUnusableInput(
      res,
      `I cannot price a token by contract address without both halves of the pair, and ${missing} is missing. Send price_chain and token together, or send coin_id on its own for a major coin, and I will return the current USD price.`,
    );
  }
  if (chainTokenMode && !TOKEN_ADDRESS_RE.test(token)) {
    return respondUnusableInput(
      res,
      `I cannot price this token because ${quoteParam(token)} is not a valid contract address. A contract address is 42 characters long: "0x" followed by 40 hexadecimal characters. If you meant a major coin, send its name as coin_id instead, such as "bitcoin" or "ethereum", and I will return its current USD price.`,
    );
  }

  const queryType = coinId ? 'coin_id' : 'chain_token';
  const coinKey = coinId ? `coingecko:${coinId}` : `${priceChain}:${token}`;
  const query = coinId ?? `${priceChain}:${token}`;

  let priceInfo;
  try {
    priceInfo = coinId ? await getFreshestCoinPrice(coinId) : await getCoinPrice(coinKey);
  } catch (err) {
    if (err instanceof CoinNotFoundError) {
      return res.json({
        query_type: queryType,
        query,
        status: 'not_found',
        summary: `no price found for '${query}'`,
        confidence: 1.0,
        canonical: [queryType, query, 'not_found'].join(':'),
        price_usd: null,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'price lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream price data call failed', confidence: 1.0, error: err.message });
  }

  // CoinGecko's simple/price endpoint doesn't return a ticker symbol
  // (DefiLlama's does) — fall back to the coin_id itself rather than an
  // all-caps mangling of it (e.g. "bitcoin", not "BITCOIN").
  const symbol = priceInfo.symbol ?? (coinId || null);
  const as_of = priceInfo.asOfUnix != null ? new Date(priceInfo.asOfUnix * 1000).toISOString() : new Date().toISOString();
  const changeText = typeof priceInfo.change24hPct === 'number'
    ? `, ${priceInfo.change24hPct >= 0 ? 'up' : 'down'} ${Math.abs(priceInfo.change24hPct).toFixed(2)}% over 24 hours`
    : '';
  const marketCapText = typeof priceInfo.marketCapUsd === 'number'
    ? `, with a market capitalization of about $${priceInfo.marketCapUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : '';
  const SOURCE_LABELS = { coinpaprika: 'CoinPaprika', coingecko: 'CoinGecko', defillama: 'DefiLlama' };
  const sourceNames = (priceInfo.sources ?? []).map((item) => SOURCE_LABELS[item.source] ?? item.source);
  const sourceText = priceInfo.sourceCount > 1
    ? ` ${new Intl.ListFormat('en', { type: 'conjunction' }).format(sourceNames)} currently report a range of $${priceInfo.priceRangeLowUsd.toLocaleString('en-US', { maximumFractionDigits: 6 })} to $${priceInfo.priceRangeHighUsd.toLocaleString('en-US', { maximumFractionDigits: 6 })}.`
    : '';
  res.json({
    query_type: queryType,
    query,
    status: 'ok',
    summary: `${symbol ?? query} is currently $${priceInfo.priceUsd.toLocaleString('en-US', { maximumFractionDigits: 6 })} USD${changeText}${marketCapText}.${sourceText}`,
    confidence: 1.0,
    canonical: [queryType, query, priceInfo.priceUsd].join(':'),
    price_usd: priceInfo.priceUsd,
    symbol,
    price_source: priceInfo.source ?? 'defillama',
    sources: priceInfo.sources ?? [{ source: priceInfo.source ?? 'defillama', price_usd: priceInfo.priceUsd }],
    source_count: priceInfo.sourceCount ?? 1,
    price_range_low_usd: priceInfo.priceRangeLowUsd ?? priceInfo.priceUsd,
    price_range_high_usd: priceInfo.priceRangeHighUsd ?? priceInfo.priceUsd,
    change_24h_pct: priceInfo.change24hPct ?? null,
    market_cap_usd: priceInfo.marketCapUsd ?? null,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleCryptoPrice(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleCryptoPrice(req, res)));

export default router;
