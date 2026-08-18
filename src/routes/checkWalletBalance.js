// WALLET_BALANCE_CHECK signal endpoint. No ground truth exists for this
// intent yet (checked live against /groundtruths/WALLET_BALANCE_CHECK,
// 2026-08-18) — speculative on Telegraph adding grading before Track 1
// closes, same caveat as checkGasPrice.js.

import { Router } from 'express';
import { getBalance, getBlockNumber, withRpcBudget, RpcBudgetExceededError, ApiKeyMissingError } from '../lib/ankrRpc.js';
import { CHAINS, DEFAULT_CHAIN, resolveChain } from '../lib/chains.js';

const router = Router();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function handleWalletBalance(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const address = params?.address;
  const chainParam = params?.chain ?? DEFAULT_CHAIN;

  if (!address || !ADDRESS_RE.test(address)) {
    return res.status(400).json({
      status: 'error',
      summary: 'must include a valid `address` query parameter (0x-prefixed, 40 hex characters)',
      confidence: 1.0,
      error: req.method === 'GET' ? 'must include valid `address` query parameter' : 'body must include valid `address`',
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

  let balanceHex;
  let blockNumberHex;
  try {
    [balanceHex, blockNumberHex] = await Promise.all([
      getBalance(chain.segment, address),
      getBlockNumber(chain.segment).catch(() => null),
    ]);
  } catch (err) {
    if (err instanceof ApiKeyMissingError) {
      return res.status(503).json({ status: 'error', summary: 'wallet balance signal unavailable', confidence: 1.0, error: err.message });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'wallet balance lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream RPC call failed', confidence: 1.0, error: err.message });
  }

  const balance_wei = BigInt(balanceHex).toString();
  const balance_native = Number(balanceHex) / 1e18;
  const block_number = blockNumberHex != null ? Number(BigInt(blockNumberHex)) : null;
  const as_of = new Date().toISOString();

  const canonical = [chainParam, address, balance_wei].join(':');

  res.json({
    chain: chainParam,
    address,
    status: 'ok',
    summary: `${address} holds ${balance_native.toFixed(6)} native ${chain.label} tokens`,
    confidence: 1.0,
    canonical,
    balance_wei,
    balance_native,
    block_number,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleWalletBalance(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleWalletBalance(req, res)));

export default router;
