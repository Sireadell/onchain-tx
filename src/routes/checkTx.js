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
import { CHAINS, DEFAULT_CHAIN, resolveChain } from '../lib/chains.js';

const router = Router();

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

async function handleCheckTx(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const txHash = params?.tx_hash;
  // No chain param at all -> DEFAULT_CHAIN, preserving pre-multi-chain
  // behavior for existing callers. An explicit but unrecognized chain is a
  // validation error, not a silent fallback.
  const chainParam = params?.chain ?? DEFAULT_CHAIN;

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

  const chain = resolveChain(chainParam);
  if (!chain) {
    return res.status(400).json({
      status: 'error',
      summary: `unsupported chain '${chainParam}' — must be one of: ${Object.keys(CHAINS).join(', ')}`,
      confidence: 1.0,
      error: 'unsupported `chain` parameter',
    });
  }

  let tx;
  let receipt;
  let currentBlockNumberHex;
  try {
    // All three run concurrently — blockNumber doesn't depend on tx/receipt,
    // and previously ran sequentially after them, adding a full unnecessary
    // RTT to every request. It stays best-effort: its own failure is caught
    // here and degrades to null, without rejecting the whole Promise.all
    // (which would otherwise also fail the tx/receipt lookups).
    [tx, receipt, currentBlockNumberHex] = await Promise.all([
      getTransactionByHash(chain.segment, txHash),
      getTransactionReceipt(chain.segment, txHash),
      getBlockNumber(chain.segment).catch(() => null),
    ]);
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

  // Compact, deterministic one-line summary of the verdict — chain:tx_hash:
  // status:block_number:block_hash:receipt_status, `-` standing in for any
  // field that's null (not_found/pending never have a block). Matches the
  // convergent pattern used by other registered ONCHAIN_TX_LOOKUP miners.
  const canonical = [
    chainParam,
    txHash,
    result.status,
    result.block_number ?? '-',
    result.block_hash ?? '-',
    result.receipt_status ?? '-',
  ].join(':');

  res.json({
    tx_hash: txHash,
    chain: chainParam,
    status: result.status,
    summary: result.summary,
    confidence: result.confidence,
    canonical,
    from: result.from,
    to: result.to,
    value_wei: result.value_wei,
    block_number: result.block_number,
    block_hash: result.block_hash,
    receipt_status: result.receipt_status,
  });
}

// Each request gets its own RPC budget, same pattern as Miner #1's
// checkWallet.js — wrapped at route level so the budget's lifetime matches
// exactly one HTTP request.
router.get('/', (req, res) => withRpcBudget(() => handleCheckTx(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleCheckTx(req, res)));

export default router;
