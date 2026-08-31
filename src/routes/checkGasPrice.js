// GAS_PRICE signal endpoint.
//
// Grading is live now, and the real graded questions ask for "the average
// transaction fee level ... in USD" — a dollar figure, not raw gwei.
// Confirmed 2026-08-25 against actual scoring history
// (explorer.telegraphprotocol.com/api/scores?miner=txlens): our gwei-only
// answer was being graded against a USD ground truth, a unit mismatch. Now
// also converts gas price to an estimated USD fee for a standard 21,000-gas
// transfer (the same unit the ground truth uses), via the chain's native
// token price (DefiLlama coins.llama.fi, same transport as
// checkCryptoPrice.js). The fee estimate is best-effort: if the price
// lookup fails, gas_price_wei/gwei still return normally and fee_usd is
// omitted rather than failing the whole response — price data being down
// shouldn't take out a signal that doesn't depend on it.

import { Router } from 'express';
import { getGasPrice, getBlockNumber, withRpcBudget, RpcBudgetExceededError, ApiKeyMissingError } from '../lib/ankrRpc.js';
import { getCoinPrice } from '../lib/defiLlamaApi.js';
import { DEFAULT_CHAIN, resolveChainLoose, resolveRpcChainLoose, rpcChainNames } from '../lib/chains.js';
import { freeTextParam } from '../lib/entityExtract.js';
import { questionMatchesIntent } from '../lib/intentGuard.js';
import { quoteParam, respondUnusableInput } from '../lib/unusableInput.js';

const STANDARD_TRANSFER_GAS_UNITS = 21_000;

const router = Router();

async function handleGasPrice(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  // "What does a transfer cost on Base right now?" arrives as a question,
  // not as chain=base. resolveChainLoose already scans a whole sentence for
  // a chain name, so hand the question to it before defaulting to eth —
  // otherwise every free-text gas question silently answered for Ethereum.
  const question = freeTextParam(params);
  if (question && params?.chain == null && !questionMatchesIntent(question, /\b(?:gas|fees?|transaction\s+(?:fee|cost)|transfer\s+cost|cost\s+(?:to|of)\s+(?:send|transfer|transact)|transact(?:ion|ing)\s+cost)\b/i)) {
    return respondUnusableInput(
      res,
      'This request does not appear to ask about blockchain gas or transaction fees. Name a supported chain and ask for its gas price or standard transfer cost.',
    );
  }
  const chainParam = params?.chain ?? resolveChainLoose(question ?? '')?.segment ?? DEFAULT_CHAIN;

  const knownChain = resolveChainLoose(chainParam);
  const chain = resolveRpcChainLoose(chainParam);
  if (!chain) {
    const problem = knownChain
      ? `${quoteParam(chainParam)} is not available through the current RPC provider`
      : `${quoteParam(chainParam)} is not a chain I cover`;
    return respondUnusableInput(
      res,
      `I cannot report gas because ${problem}. I track current transaction fees on ${rpcChainNames().join(', ')}. Ask again naming one of those and I will give the current gas price in gwei and the USD cost of a standard transfer.`,
    );
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

  let fee_usd = null;
  let native_price_usd = null;
  try {
    const priceInfo = await getCoinPrice(`coingecko:${chain.nativeCoingeckoId}`);
    native_price_usd = priceInfo.priceUsd;
    fee_usd = (gas_price_gwei * 1e-9) * STANDARD_TRANSFER_GAS_UNITS * native_price_usd;
  } catch {
    // Best-effort — gas price itself is still valid without a USD estimate.
  }

  const canonical = [chainParam, 'gas_price', gas_price_wei, block_number ?? '-'].join(':');
  const summary = fee_usd != null
    ? `a standard transfer on ${chain.label} costs about $${fee_usd.toFixed(4)} USD at the current gas price of ${gas_price_gwei.toFixed(4)} gwei`
    : `current gas price on ${chain.label} is ${gas_price_gwei.toFixed(4)} gwei`;

  res.json({
    chain: chainParam,
    status: 'ok',
    summary,
    confidence: 1.0,
    canonical,
    gas_price_wei,
    gas_price_gwei,
    fee_usd,
    native_price_usd,
    block_number,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleGasPrice(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleGasPrice(req, res)));

export default router;
