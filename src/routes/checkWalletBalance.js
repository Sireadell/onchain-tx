// WALLET_BALANCE_CHECK signal endpoint. No ground truth exists for this
// intent yet (checked live against /groundtruths/WALLET_BALANCE_CHECK,
// 2026-08-18) — speculative on Telegraph adding grading before Track 1
// closes, same caveat as checkGasPrice.js.
//
// Optional `token` param switches from native balance to ERC-20 balance:
// raw amount via Ankr eth_call (getTokenBalance), decimals/symbol/name via
// Blockscout's already-built getTokenInfo (same source /token-holders
// uses) so the response can report a human-normalized amount too, not
// just the raw integer. If Blockscout doesn't recognize the token but the
// eth_call still succeeded (some valid ERC-20s aren't indexed), the raw
// balance is still returned with decimals/symbol/name left null rather
// than failing the whole request.

import { Router } from 'express';
import {
  getBalance,
  getTokenBalance,
  getBlockNumber,
  withRpcBudget,
  RpcBudgetExceededError,
  ApiKeyMissingError,
} from '../lib/ankrRpc.js';
import { getTokenInfo, TokenNotFoundError } from '../lib/blockscoutApi.js';
import { CHAINS, DEFAULT_CHAIN, resolveChain } from '../lib/chains.js';
import { quoteParam, respondUnusableInput } from '../lib/unusableInput.js';

const router = Router();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function handleNativeBalance(req, res, address, chainParam, chain) {
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

async function handleTokenBalance(req, res, address, chainParam, chain, token) {
  let balanceHex;
  try {
    balanceHex = await getTokenBalance(chain.segment, token, address);
  } catch (err) {
    if (err instanceof ApiKeyMissingError) {
      return res.status(503).json({ status: 'error', summary: 'wallet balance signal unavailable', confidence: 1.0, error: err.message });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'wallet balance lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream RPC call failed', confidence: 1.0, error: err.message });
  }

  const balance_wei = BigInt(balanceHex ?? '0x0').toString();

  let decimals = null;
  let token_symbol = null;
  let token_name = null;
  try {
    const info = await getTokenInfo(chain.blockscoutHost, token);
    decimals = info.decimals != null ? Number(info.decimals) : null;
    token_symbol = info.symbol;
    token_name = info.name;
  } catch (err) {
    if (!(err instanceof TokenNotFoundError)) throw err;
  }

  const balance_native = decimals != null ? Number(balance_wei) / 10 ** decimals : null;
  const as_of = new Date().toISOString();
  const canonical = [chainParam, address, token, balance_wei].join(':');

  res.json({
    chain: chainParam,
    address,
    token,
    status: 'ok',
    summary:
      balance_native != null
        ? `${address} holds ${balance_native.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${token_symbol ?? token} on ${chain.label}`
        : `${address} holds ${balance_wei} (raw, unknown decimals) of ${token} on ${chain.label}`,
    confidence: 1.0,
    canonical,
    balance_wei,
    balance_native,
    token_decimals: decimals,
    token_symbol,
    token_name,
    as_of,
  });
}

async function handleWalletBalance(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const address = params?.address;
  const chainParam = params?.chain ?? DEFAULT_CHAIN;
  const token = params?.token;

  if (!address || !ADDRESS_RE.test(address)) {
    const problem = address
      ? `${quoteParam(address)} is not a valid wallet address`
      : 'no wallet address was supplied';
    return respondUnusableInput(
      res,
      `I cannot check this balance because ${problem}. A wallet address is 42 characters long: "0x" followed by 40 hexadecimal characters. An ENS name or a transaction hash will not work here. Pass an address as the address parameter and I will return its native balance, plus its balance of any ERC-20 token you name.`,
    );
  }
  if (token && !ADDRESS_RE.test(token)) {
    return respondUnusableInput(
      res,
      `I can read the wallet address, but I cannot check the token balance because ${quoteParam(token)} is not a valid token contract address. I need the token's contract address, 42 characters long: "0x" followed by 40 hexadecimal characters. A ticker such as USDC will not work here. Drop the token parameter and I will return the wallet's native balance instead.`,
    );
  }

  const chain = resolveChain(chainParam);
  if (!chain) {
    return respondUnusableInput(
      res,
      `I cannot check a balance on ${quoteParam(chainParam)} because it is not a chain I index. I can read balances on ${Object.keys(CHAINS).join(', ')}. Ask again naming one of those and I will return the wallet's balance there.`,
    );
  }

  if (token) {
    return handleTokenBalance(req, res, address, chainParam, chain, token);
  }
  return handleNativeBalance(req, res, address, chainParam, chain);
}

router.get('/', (req, res) => withRpcBudget(() => handleWalletBalance(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleWalletBalance(req, res)));

export default router;
