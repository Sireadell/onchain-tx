// ONCHAIN_TX_LOOKUP signal endpoint — the one route this miner exposes.
// See BUILD_SPEC.md for the frozen contract (signal_mapping fields, test
// cases, confidence semantics).

import { Router } from 'express';
import {
  getTransactionByHash,
  getTransactionReceipt,
  getBlockNumber,
  withRpcBudget,
  RpcBudgetExceededError,
  ApiKeyMissingError,
} from '../lib/ankrRpc.js';
import { evaluateTransaction } from '../lib/txStatus.js';

const router = Router();

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

async function handleCheckTx(req, res) {
  const txHash = req.method === 'GET' ? req.query?.tx_hash : req.body?.tx_hash;

  if (!txHash || !TX_HASH_RE.test(txHash)) {
    return res.status(400).json({
      status: 'error',
      summary: 'must include a valid `tx_hash` query parameter (0x-prefixed, 64 hex characters)',
      confidence: 1.0,
      error:
        req.method === 'GET'
          ? 'must include valid `tx_hash` query parameter'
          : 'body must include valid `tx_hash`',
    });
  }

  let tx;
  let receipt;
  let currentBlockNumberHex;
  try {
    [tx, receipt] = await Promise.all([getTransactionByHash(txHash), getTransactionReceipt(txHash)]);
    // Best-effort — used only to compute confirmation depth for confidence.
    // A failure here shouldn't take down an otherwise-successful lookup.
    try {
      currentBlockNumberHex = await getBlockNumber();
    } catch {
      currentBlockNumberHex = null;
    }
  } catch (err) {
    if (err instanceof ApiKeyMissingError) {
      return res.status(503).json({
        status: 'error',
        summary: 'transaction lookup signal unavailable',
        confidence: 1.0,
        error: err.message,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({
        status: 'error',
        summary: 'transaction lookup could not complete within budget',
        confidence: 1.0,
        error: err.message,
      });
    }
    return res.status(502).json({
      status: 'error',
      summary: 'upstream RPC call failed',
      confidence: 1.0,
      error: err.message,
    });
  }

  const result = evaluateTransaction({ tx, receipt, currentBlockNumberHex });

  res.json({
    tx_hash: txHash,
    status: result.status,
    summary: result.summary,
    confidence: result.confidence,
    from: result.from,
    to: result.to,
    value_wei: result.value_wei,
    block_number: result.block_number,
  });
}

// Each request gets its own RPC budget, same pattern as Miner #1's
// checkWallet.js — wrapped at route level so the budget's lifetime matches
// exactly one HTTP request.
router.get('/', (req, res) => withRpcBudget(() => handleCheckTx(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleCheckTx(req, res)));

export default router;
