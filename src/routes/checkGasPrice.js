// GAS_PRICE signal endpoint. No ground truth exists for this intent yet
// (checked live against /groundtruths/GAS_PRICE, 2026-08-18) — this is
// speculative on Telegraph adding grading before Track 1 closes, kept
// intentionally simple rather than guessing at a scoring rubric that
// doesn't exist yet.

import { Router } from 'express';
import { getGasPrice, getBlockNumber, withRpcBudget, RpcBudgetExceededError, ApiKeyMissingError } from '../lib/ankrRpc.js';
import { CHAINS, DEFAULT_CHAIN, resolveChain } from '../lib/chains.js';

const router = Router();

async function handleGasPrice(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const chainParam = params?.chain ?? DEFAULT_CHAIN;

  const chain = resolveChain(chainParam);
  if (!chain) {
    return res.status(400).json({
      status: 'error',
      summary: `unsupported chain '${chainParam}' — must be one of: ${Object.keys(CHAINS).join(', ')}`,
      confidence: 1.0,
      error: 'unsupported `chain` parameter',
    });
  }

  let gasPriceHex;
  let blockNumberHex;
  try {
    [gasPriceHex, blockNumberHex] = await Promise.all([
      getGasPrice(chain.segment),
      getBlockNumber(chain.segment).catch(() => null),
    ]);
  } catch (err) {
    if (err instanceof ApiKeyMissingError) {
      return res.status(503).json({ status: 'error', summary: 'gas price signal unavailable', confidence: 1.0, error: err.message });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'gas price lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream RPC call failed', confidence: 1.0, error: err.message });
  }

  const gas_price_wei = BigInt(gasPriceHex).toString();
  const gas_price_gwei = Number(gasPriceHex) / 1e9;
  const block_number = blockNumberHex != null ? Number(BigInt(blockNumberHex)) : null;
  const as_of = new Date().toISOString();

  const canonical = [chainParam, 'gas_price', gas_price_wei, block_number ?? '-'].join(':');

  res.json({
    chain: chainParam,
    status: 'ok',
    summary: `current gas price on ${chain.label} is ${gas_price_gwei.toFixed(4)} gwei`,
    confidence: 1.0,
    canonical,
    gas_price_wei,
    gas_price_gwei,
    block_number,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleGasPrice(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleGasPrice(req, res)));

export default router;
