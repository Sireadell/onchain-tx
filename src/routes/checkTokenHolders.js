// TOKEN_HOLDER_COUNT signal endpoint. No ground truth exists for this
// intent yet (checked live against /groundtruths/TOKEN_HOLDER_COUNT,
// 2026-08-18) — same speculative-on-grading caveat as the other two new
// endpoints. Uses Blockscout's REST API, not Ankr's JSON-RPC (Ankr has no
// direct holder-count method) — see blockscoutApi.js.

import { Router } from 'express';
import { getTokenInfo, TokenNotFoundError } from '../lib/blockscoutApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { CHAINS, DEFAULT_CHAIN, resolveChain } from '../lib/chains.js';

const router = Router();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function handleTokenHolders(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const token = params?.token;
  const chainParam = params?.chain ?? DEFAULT_CHAIN;

  if (!token || !ADDRESS_RE.test(token)) {
    return res.status(400).json({
      status: 'error',
      summary: 'must include a valid `token` query parameter (0x-prefixed, 40 hex characters)',
      confidence: 1.0,
      error: req.method === 'GET' ? 'must include valid `token` query parameter' : 'body must include valid `token`',
    });
  }

  const chain = resolveChain(chainParam);
  if (!chain) {
    return res.status(400).json({
      status: 'error',
      summary: `unsupported chain '${chainParam}' — must be one of: ${Object.keys(CHAINS).join(', ')}`,
      confidence: 1.0,
      error: 'unsupported `chain` parameter',
    });
  }

  let info;
  try {
    info = await getTokenInfo(chain.blockscoutHost, token);
  } catch (err) {
    if (err instanceof TokenNotFoundError) {
      return res.json({
        chain: chainParam,
        token,
        status: 'not_found',
        summary: `no ERC-20 token found at ${token} on ${chain.label}`,
        confidence: 1.0,
        canonical: [chainParam, token, 'not_found'].join(':'),
        holders_count: null,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'token holder lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream token data call failed', confidence: 1.0, error: err.message });
  }

  const holders_count = info.holdersCount != null ? Number(info.holdersCount) : null;
  const as_of = new Date().toISOString();
  const canonical = [chainParam, token, holders_count ?? '-'].join(':');

  res.json({
    chain: chainParam,
    token,
    status: 'ok',
    summary:
      holders_count != null
        ? `${info.symbol ?? token} has ${holders_count.toLocaleString('en-US')} holders on ${chain.label}`
        : `${token} found on ${chain.label} but no holder count is available`,
    confidence: 1.0,
    canonical,
    holders_count,
    token_name: info.name,
    token_symbol: info.symbol,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleTokenHolders(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleTokenHolders(req, res)));

export default router;
