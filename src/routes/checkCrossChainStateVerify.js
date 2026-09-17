// CROSS_CHAIN_STATE_VERIFY signal endpoint. Checks the same address's
// on-chain state (native balance, and whether it holds contract code) on
// every supported chain, so a caller can verify where an address is
// active rather than asking about one chain at a time. Reuses ankrRpc.js
// and chains.js, the same RPC layer ONCHAIN_TX_LOOKUP and
// WALLET_BALANCE_CHECK already use. Params: address (required, also
// accepted as wallet/account/question). Optional: chains (comma-separated
// list, defaults to every RPC-enabled chain, or to the chains the
// question itself names: "does this wallet exist on Base and Arbitrum").

import { Router } from 'express';
import {
  getBalance,
  getCode,
  withRpcBudget,
  ApiKeyMissingError,
  RpcBudgetExceededError,
} from '../lib/ankrRpc.js';
import { rpcChainNames, resolveRpcChainLoose, resolveChainLoose, CHAINS } from '../lib/chains.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { extractAddress, freeTextParam, firstUsableValue } from '../lib/entityExtract.js';
import { amountToDecimalString } from '../lib/formatAmount.js';
import { safeBigIntFromHex } from '../lib/safeBigInt.js';

const router = Router();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ENS_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth\b/i;
// EIP-7702 delegation designator: 0xef0100 followed by the delegate's
// address. An externally owned account with one of these reads as having
// code, but it is still a wallet (vitalik.eth carries one, live-checked
// 2026-09-16), so it is reported as such rather than as a contract.
const DELEGATION_PREFIX = /^0xef0100/i;

// Chains people ask about that this miner has no RPC for. Named in the
// answer so "is it active on Solana" gets an honest "cannot check Solana"
// instead of a silent answer about five other chains.
const UNSUPPORTED_CHAIN_RE = /\b(solana|bitcoin|btc|tron|cosmos|near|aptos|sui|ton|cardano|dogecoin|litecoin|xrp|ripple|starknet|zksync|linea|scroll|blast|mantle|gnosis|fantom|bnb|bsc|binance smart chain|celo|moonbeam|cronos|sei|monad|berachain|sonic|unichain|world chain|optimism|op mainnet)\b/gi;

const MAX_CHAIN_PARAM_CHARS = 300;

function chainLabel(name) {
  return name.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Btc$/, 'Bitcoin').replace(/^Bsc$|^Bnb$/, 'BNB Chain');
}

// Splits a chains value ("eth,base", "Ethereum and Arbitrum") into the
// chains this miner can query and the names it cannot.
function parseChainList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { chains: null, unsupported: [] };
  const names = raw.slice(0, MAX_CHAIN_PARAM_CHARS).split(/[,;/]|\band\b|\bvs\.?\b|\bversus\b/i).map((c) => c.trim()).filter(Boolean);
  const chains = [];
  const unsupported = [];
  for (const name of names) {
    const chain = resolveRpcChainLoose(name);
    if (chain) {
      if (!chains.includes(chain)) chains.push(chain);
    } else {
      unsupported.push(name);
    }
  }
  return { chains: chains.length ? chains : null, unsupported };
}

// The chains a free-text question names, in the order named. A question
// naming none is a "which chains" question and gets every chain.
function chainsNamedIn(text) {
  if (typeof text !== 'string') return { chains: null, unsupported: [] };
  const chains = [];
  const lower = text.toLowerCase();
  for (const name of Object.keys(CHAINS)) {
    const chain = resolveChainLoose(name);
    if (!chain) continue;
    // The bare key "eth" is skipped: "the ETH balance on Base" names the
    // token, not the Ethereum chain. "ethereum" and "mainnet" still count.
    const terms = [chain.label.toLowerCase(), ...(name === 'eth' ? ['mainnet'] : [name])];
    const mention = terms.some((term) => new RegExp(`(?:^|[^a-z0-9])${term}(?:$|[^a-z0-9])`, 'i').test(lower));
    if (mention && !chains.includes(chain)) chains.push(chain);
  }
  const unsupported = [...new Set([...text.matchAll(UNSUPPORTED_CHAIN_RE)].map((m) => m[1].toLowerCase()))];
  const rpcChains = chains.filter((c) => resolveRpcChainLoose(c.key));
  const named = chains.filter((c) => !resolveRpcChainLoose(c.key)).map((c) => c.label.toLowerCase());
  return { chains: rpcChains.length ? rpcChains : null, unsupported: [...new Set([...unsupported, ...named])] };
}

async function checkOneChain(chain, address) {
  try {
    const [balanceHex, code] = await Promise.all([
      getBalance(chain.segment, address),
      getCode(chain.segment, address),
    ]);
    const balance_wei = safeBigIntFromHex(balanceHex).toString();
    const hasCode = Boolean(code && code !== '0x');
    const delegated = hasCode && DELEGATION_PREFIX.test(code);
    return {
      chain: chain.key,
      reachable: true,
      balance_wei,
      balance_native: amountToDecimalString(balance_wei, 18),
      native_symbol: chain.nativeSymbol,
      is_contract: hasCode && !delegated,
      eip7702_delegated: delegated,
      active: balance_wei !== '0' || hasCode,
      error: null,
    };
  } catch (err) {
    return {
      chain: chain.key,
      reachable: false,
      balance_wei: null,
      balance_native: null,
      native_symbol: chain.nativeSymbol,
      is_contract: null,
      eip7702_delegated: null,
      active: null,
      error: err.message,
    };
  }
}

function describeKind(r) {
  if (r.is_contract) return 'contract';
  if (r.eip7702_delegated) return 'wallet with EIP-7702 delegation';
  return 'wallet';
}

function trimBalance(value) {
  // "0.159136244717382839" reads better as 0.1591 in a sentence; the exact
  // figure stays in the results array.
  if (!value) return value;
  const [whole, frac = ''] = String(value).split('.');
  if (!frac) return whole;
  const kept = frac.replace(/0+$/, '').slice(0, whole === '0' ? 6 : 4).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

async function handleCrossChainStateVerify(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const question = freeTextParam(params);
  const rawAddress = firstUsableValue(params.address, params.wallet, params.account, params.contract, question);
  const addressText = rawAddress == null ? null : String(rawAddress).slice(0, 2_000);
  const address = addressText && ADDRESS_RE.test(addressText) ? addressText : extractAddress(addressText);

  if (!address) {
    const ens = addressText?.match(ENS_RE)?.[0] ?? null;
    const problem = ens
      ? `${quoteParam(ens)} is an ENS name, and this endpoint reads raw addresses only; resolve it to its 0x address first`
      : addressText
        ? `${quoteParam(addressText)} does not contain a valid address`
        : 'no address was supplied';
    return respondUnusableInput(
      res,
      `I cannot verify cross-chain state because ${problem}. An address is 42 characters long: "0x" followed by 40 hexadecimal characters. Pass one as the address parameter and I will report its balance and contract status on ${rpcChainNames().map((n) => CHAINS[n].label).join(', ')}.`,
    );
  }

  // An explicit chains param wins; otherwise the chains the question
  // names; otherwise every chain with an RPC.
  const explicit = parseChainList(params.chains);
  const fromQuestion = explicit.chains ? { chains: null, unsupported: [] } : chainsNamedIn([question, addressText].filter(Boolean).join(' '));
  const chainList = explicit.chains ?? fromQuestion.chains ?? rpcChainNames().map((name) => CHAINS[name]);
  const unsupported = [...new Set([...explicit.unsupported, ...fromQuestion.unsupported])];

  let results;
  try {
    results = await withRpcBudget(() => Promise.all(chainList.map((chain) => checkOneChain(chain, address))));
  } catch (err) {
    if (err instanceof ApiKeyMissingError) {
      return res.status(503).json({ status: 'error', summary: 'cross-chain verification signal unavailable', confidence: 1.0, error: err.message });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'cross-chain verification could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream RPC call failed', confidence: 1.0, error: err.message });
  }

  const active = results.filter((r) => r.active);
  const reachable = results.filter((r) => r.reachable);
  const unreachable = results.filter((r) => !r.reachable);

  if (reachable.length === 0) {
    return res.status(502).json({
      status: 'error',
      summary: `${address} could not be checked on any of ${chainList.map((c) => c.label).join(', ')}: every chain read failed. Retry shortly.`,
      confidence: 0,
      error: unreachable.map((r) => `${r.chain}: ${r.error}`).join('; '),
    });
  }

  const parts = [];
  if (active.length === 0) {
    parts.push(`${address} shows no balance and no contract code on ${reachable.map((r) => CHAINS[r.chain].label).join(', ')}, so it appears inactive there.`);
  } else {
    parts.push(`${address} is active on ${active.map((r) => `${CHAINS[r.chain].label} (${describeKind(r)}, ${trimBalance(r.balance_native)} ${r.native_symbol})`).join('; ')}.`);
    const inactive = reachable.filter((r) => !r.active);
    if (inactive.length) parts.push(`No balance or code on ${inactive.map((r) => CHAINS[r.chain].label).join(', ')}.`);
  }
  if (unreachable.length) parts.push(`${unreachable.map((r) => CHAINS[r.chain].label).join(', ')} could not be read right now.`);
  if (unsupported.length) parts.push(`${unsupported.map(chainLabel).join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not checked by this miner, which covers ${rpcChainNames().map((n) => CHAINS[n].label).join(', ')} only.`);

  res.json({
    address,
    status: 'ok',
    summary: parts.join(' '),
    confidence: unreachable.length === 0 ? 1.0 : 0.7,
    canonical: ['cross-chain-state-verify', address, active.map((r) => r.chain).sort().join(',')].join(':'),
    chains_checked: chainList.map((c) => c.key),
    chains_unsupported: unsupported,
    results,
    as_of: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleCrossChainStateVerify(req, res));
router.post('/', (req, res) => handleCrossChainStateVerify(req, res));

export default router;
