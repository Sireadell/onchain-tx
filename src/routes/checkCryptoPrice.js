// CRYPTO_PRICE signal endpoint. No ground truth exists for this intent
// yet (checked live against /groundtruths/CRYPTO_PRICE, 2026-08-18) — same
// speculative-on-grading caveat as the other new endpoints. Uses
// DefiLlama's public price API, same transport as checkTvl.js. Accepts
// either `coin_id` (a CoinGecko id, e.g. "bitcoin") or a `price_chain` +
// `token` pair (e.g. price_chain=ethereum, token=0xA0b8...eB48 for a
// specific on-chain token's price) — exactly one mode. `price_chain` is
// deliberately separate from `chain` (used by the other four endpoints)
// for the same reason as /tvl's `tvl_chain`: DefiLlama's chain namespace
// isn't restricted to our five-chain enum.

import { Router } from 'express';
import { getCoinPrice, CoinNotFoundError } from '../lib/defiLlamaApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';

const router = Router();

const TOKEN_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function handleCryptoPrice(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const coinId = params?.coin_id;
  const priceChain = params?.price_chain;
  const token = params?.token;

  const chainTokenMode = Boolean(priceChain || token);
  if (!coinId && !chainTokenMode) {
    return res.status(400).json({
      status: 'error',
      summary: 'must include either `coin_id` (CoinGecko id) or both `price_chain` and `token` (on-chain token price)',
      confidence: 1.0,
      error: 'missing `coin_id` or `price_chain`+`token` parameters',
    });
  }
  if (coinId && chainTokenMode) {
    return res.status(400).json({
      status: 'error',
      summary: 'must include only one of `coin_id` or `price_chain`+`token`, not both',
      confidence: 1.0,
      error: '`coin_id` and `price_chain`/`token` both supplied',
    });
  }
  if (chainTokenMode && (!priceChain || !token)) {
    return res.status(400).json({
      status: 'error',
      summary: 'on-chain token price lookup requires both `price_chain` and `token`',
      confidence: 1.0,
      error: 'missing `price_chain` or `token`',
    });
  }
  if (chainTokenMode && !TOKEN_ADDRESS_RE.test(token)) {
    return res.status(400).json({
      status: 'error',
      summary: '`token` must be a valid 0x-prefixed, 40 hex character address',
      confidence: 1.0,
      error: 'malformed `token` parameter',
    });
  }

  const queryType = coinId ? 'coin_id' : 'chain_token';
  const coinKey = coinId ? `coingecko:${coinId}` : `${priceChain}:${token}`;
  const query = coinId ?? `${priceChain}:${token}`;

  let priceInfo;
  try {
    priceInfo = await getCoinPrice(coinKey);
  } catch (err) {
    if (err instanceof CoinNotFoundError) {
      return res.json({
        query_type: queryType,
        query,
        status: 'not_found',
        summary: `no DefiLlama price found for '${query}'`,
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

  const as_of = priceInfo.asOfUnix != null ? new Date(priceInfo.asOfUnix * 1000).toISOString() : new Date().toISOString();
  res.json({
    query_type: queryType,
    query,
    status: 'ok',
    summary: `${priceInfo.symbol ?? query} is $${priceInfo.priceUsd.toLocaleString('en-US', { maximumFractionDigits: 6 })}`,
    confidence: 1.0,
    canonical: [queryType, query, priceInfo.priceUsd].join(':'),
    price_usd: priceInfo.priceUsd,
    symbol: priceInfo.symbol,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleCryptoPrice(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleCryptoPrice(req, res)));

export default router;
