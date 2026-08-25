// TVL_LOOKUP signal endpoint. Uses DefiLlama's public API, not
// Ankr/Blockscout — TVL is an aggregated/indexed figure no chain RPC
// exposes directly. Accepts `protocol` (a DefiLlama protocol slug, e.g.
// "uniswap") and/or `tvl_chain` (a free-text DefiLlama chain name, e.g.
// "Ethereum"). Deliberately not named `chain` — that param is already
// enum-restricted to the five EVM slugs the other four endpoints use, and
// DefiLlama's chain names (~460 of them, capitalized, not limited to EVM)
// don't fit that enum.
//
// Used to reject the request outright when both were supplied. Confirmed
// live 2026-08-25 via Render request logs that Telegraph's dispatcher
// regularly sends both together for a question like "Aave V3 protocol on
// the Ethereum chain" — both facts are true, so it reasonably passes both.
// That meant every graded TVL question on a named protocol was 400ing and
// scoring as a blank answer, a bug in our own validation, not a grading or
// uptime problem. Now `protocol` wins when both are present (it's the more
// specific identifier) and `tvl_chain` is only used alone.

import { Router } from 'express';
import {
  getProtocolTvl,
  getChainTvl,
  ProtocolNotFoundError,
  ChainNotFoundError,
} from '../lib/defiLlamaApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';

const router = Router();

async function handleTvl(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const protocol = params?.protocol;
  const tvlChain = params?.tvl_chain;

  if (!protocol && !tvlChain) {
    return res.status(400).json({
      status: 'error',
      summary: 'must include a `protocol` (DefiLlama slug) and/or `tvl_chain` (DefiLlama chain name) query parameter',
      confidence: 1.0,
      error: 'missing `protocol` or `tvl_chain` parameter',
    });
  }

  // `protocol` wins when both are supplied — see file header comment.
  const queryType = protocol ? 'protocol' : 'chain';
  const query = protocol ?? tvlChain;

  let tvlUsd;
  try {
    tvlUsd = protocol ? await getProtocolTvl(protocol) : await getChainTvl(tvlChain);
  } catch (err) {
    if (err instanceof ProtocolNotFoundError || err instanceof ChainNotFoundError) {
      return res.json({
        query_type: queryType,
        query,
        status: 'not_found',
        summary: `no DefiLlama ${queryType} found for '${query}'`,
        confidence: 1.0,
        canonical: [queryType, query, 'not_found'].join(':'),
        tvl_usd: null,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'TVL lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream TVL data call failed', confidence: 1.0, error: err.message });
  }

  const as_of = new Date().toISOString();
  res.json({
    query_type: queryType,
    query,
    status: 'ok',
    summary: `${query} has $${tvlUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} TVL`,
    confidence: 1.0,
    canonical: [queryType, query, Math.round(tvlUsd)].join(':'),
    tvl_usd: tvlUsd,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleTvl(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleTvl(req, res)));

export default router;
