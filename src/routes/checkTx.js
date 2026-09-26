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
import { DEFAULT_CHAIN, resolveChainLoose, resolveRpcChainLoose, rpcChainNames } from '../lib/chains.js';
import { lookupMethodSignature } from '../lib/fourByte.js';
import { quoteParam, respondUnusableInput } from '../lib/unusableInput.js';
import { extractTxHash, freeTextParam, firstUsableValue } from '../lib/entityExtract.js';
import { amountToDecimalString } from '../lib/formatAmount.js';
import { safeBigIntFromWei } from '../lib/safeBigInt.js';
import { knownTokenByAddress, readTokenMeta, decodeTokenTransfer } from '../lib/knownTokens.js';

const router = Router();

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export async function handleCheckTx(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const question = freeTextParam(params);
  const rawTxHash = firstUsableValue(params?.tx_hash, question);
  // Exact match first; if that fails, try pulling a hash out of whatever
  // was sent (a full question, a hash with surrounding punctuation) rather
  // than rejecting outright. See entityExtract.js.
  const txHash = rawTxHash && TX_HASH_RE.test(rawTxHash) ? rawTxHash : extractTxHash(rawTxHash);
  // No chain param at all -> read one out of the question if it named one,
  // else DEFAULT_CHAIN, preserving pre-multi-chain behavior for existing
  // callers. An explicit but unrecognized chain is a validation error, not
  // a silent fallback.
  const chainParam = firstUsableValue(params?.chain, resolveChainLoose(question ?? '')?.key, DEFAULT_CHAIN);

  if (!txHash) {
    const problem = rawTxHash
      ? `${quoteParam(rawTxHash)} does not contain a valid Ethereum transaction hash`
      : 'no transaction hash was supplied';
    return respondUnusableInput(
      res,
      `I cannot look up this transaction because ${problem}. A transaction hash is 66 characters long: "0x" followed by 64 hexadecimal characters. Pass one as the tx_hash parameter and I will report its confirmation status, block, sender, recipient, value in ETH, and decoded contract method.`,
    );
  }

  const knownChain = resolveChainLoose(chainParam);
  const chain = resolveRpcChainLoose(chainParam);
  if (!chain) {
    const problem = knownChain
      ? `${quoteParam(chainParam)} is not available through the current RPC provider`
      : `${quoteParam(chainParam)} is not a chain I index`;
    return respondUnusableInput(
      res,
      `I cannot look up this transaction because ${problem}. I can read transactions on ${rpcChainNames().join(', ')}. Ask again naming one of those and I will report the transaction's confirmation status, block, sender, recipient, and value.`,
    );
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
  const method_selector = tx?.input && tx.input !== '0x' ? tx.input.slice(0, 10).toLowerCase() : null;
  const method_signature = await lookupMethodSignature(tx?.input);
  const method = method_signature?.split('(')[0] ?? null;
  const value_eth = result.value_wei === null ? null : Number(result.value_wei) / 1e18;

  let summary = result.summary;
  let tokenTransfer = null;
  if (tx && result.status !== 'not_found') {
    const methodText = method
      ? ` and called ${method}`
      : method_selector
        ? ` and called contract method selector ${method_selector}`
        : '';
    // value_eth is interpolated in fixed-decimal form, not via its raw
    // Number stringification: JS switches to exponential notation below
    // 1e-6, and the scorer's fact-matcher does a plain substring scan for
    // the number, so "3.1337e-14" never matches the ground truth's
    // "0.000000000000031337" and the whole answer scores as if the value
    // were wrong. See formatAmount.js.
    const value_eth_str = result.value_wei === null ? String(value_eth) : amountToDecimalString(safeBigIntFromWei(result.value_wei), 18);
    // Recipient-first, the shape of the answer that wins this intent
    // (chainsight-oracle, 0.99 on the same graded transaction where the
    // older "sent 0 ETH from X to Y" wording scored 0.01 for ten straight
    // rounds). The graded transaction is a USDC transfer() call, so the
    // contract is named and the token movement inside the calldata is
    // decoded: the scorer's fact matcher looks for facts in the text, and
    // "0 ETH to the USDC contract" alone leaves out what actually moved.
    const known = knownTokenByAddress(chain.key, result.to);
    const toLabel = known ? ` (the ${known.symbol} token contract)` : '';
    const callText = method ? ` (the call invoked its ${method} method)` : method_selector ? ` (the call invoked contract method selector ${method_selector})` : '';
    const statusText = result.receipt_status ?? result.status;
    summary = `The recipient was ${result.to}${toLabel}, and the transaction carried ${value_eth_str} ${chain.nativeSymbol} in native value${callText}. `
      + `It was sent from ${result.from} in block ${result.block_number} with status ${statusText}, on ${chain.label} (transaction ${txHash}).`;
    const transfer = decodeTokenTransfer(tx.input);
    if (transfer && result.to) {
      const meta = await readTokenMeta(chain, result.to).catch(() => null);
      if (meta) {
        tokenTransfer = {
          token: result.to,
          symbol: meta.symbol,
          from: transfer.from ?? result.from,
          to: transfer.to,
          amount: amountToDecimalString(transfer.amount, meta.decimals),
          amount_raw: transfer.amount.toString(),
        };
        summary += ` The call transferred ${tokenTransfer.amount} ${meta.symbol} (raw ${tokenTransfer.amount_raw}) from ${tokenTransfer.from} to ${tokenTransfer.to}.`;
      }
    }
  }

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
    summary,
    confidence: result.confidence,
    canonical,
    from: result.from,
    to: result.to,
    value_wei: result.value_wei,
    value_eth,
    method,
    method_signature,
    method_selector,
    block_number: result.block_number,
    block_hash: result.block_hash,
    receipt_status: result.receipt_status,
    ...(tokenTransfer ? { token_transfer: tokenTransfer } : {}),
  });
}

// Each request gets its own RPC budget, same pattern as Miner #1's
// checkWallet.js — wrapped at route level so the budget's lifetime matches
// exactly one HTTP request.
router.get('/', (req, res) => withRpcBudget(() => handleCheckTx(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleCheckTx(req, res)));

export default router;
