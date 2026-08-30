// Turns a dead end into an answer.
//
// When a lookup misses, the endpoint used to reply with a refusal: "no
// price found for 'ethereum:0x28C6...'". That is true and useless. It also
// scores near zero, because the graded field is compared against a real
// sentence and a refusal shares almost nothing with one.
//
// Found live 2026-08-30 in signal 0xb400cf7e: the engine was asked for the
// total value locked of 0x28C6c06298d514Db089934071355E5743bf21d60, routed
// the question to /crypto-price, and TxLens answered "no price found".
// Checked directly against Ethereum, that address has no contract code at
// all: it is an ordinary wallet holding roughly 124418 ETH, so it has no
// token price and no total value locked, and both of those facts were
// already reachable with calls this miner makes all day.
//
// So on a miss, say what the address actually is. One extra RPC call
// (eth_getCode) separates a wallet from a contract, and the native balance
// is already cached machinery. The result is a full sentence stating a
// true, checkable fact about the thing that was asked about.
//
// This never invents data. If the extra calls fail or the budget is spent,
// the caller gets the original refusal rather than a guess, because a
// wrong confident sentence is worse than an honest empty one.

import { getBalance, getCode } from './ankrRpc.js';
import { amountToDecimalString } from './formatAmount.js';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * What an address turns out to be, or null when that could not be
 * established. Never throws: every caller here is already on a failure
 * path, and a second failure must not turn a usable refusal into a 502.
 *
 * @returns {Promise<null | {kind: 'wallet'|'contract', balanceEth: string|null}>}
 */
export async function classifyAddress(chainSegment, address) {
  if (!ADDRESS_RE.test(String(address ?? ''))) return null;
  try {
    const code = await getCode(chainSegment, address);
    // "0x" (and the odd node that answers "0x0") means no code deployed,
    // which is the definition of an externally owned account.
    const isContract = typeof code === 'string' && code.length > 4;
    if (isContract) return { kind: 'contract', balanceEth: null };

    let balanceEth = null;
    try {
      const balanceHex = await getBalance(chainSegment, address);
      balanceEth = amountToDecimalString(BigInt(balanceHex), 18);
    } catch {
      // A wallet with an unreadable balance is still usefully identified as
      // a wallet, so this is not fatal to the answer.
    }
    return { kind: 'wallet', balanceEth };
  } catch {
    return null;
  }
}

/**
 * A full sentence explaining why `address` has no <thing>, naming what it
 * actually is. Returns null when nothing better than the original refusal
 * could be established.
 *
 * `missing` names what was looked for, in the caller's own terms, so the
 * answer stays in the vocabulary of the question that was asked: "no token
 * price", "no total value locked", "no holder count".
 */
export async function describeAddressMiss(chainSegment, address, chainLabel, missing) {
  const info = await classifyAddress(chainSegment, address);
  if (!info) return null;

  if (info.kind === 'contract') {
    return `${address} is a contract on ${chainLabel}, but no ${missing} is available for it.`;
  }
  const held = info.balanceEth != null
    ? ` It currently holds ${info.balanceEth} ${chainLabel === 'Ethereum' ? 'ETH' : `native ${chainLabel} tokens`}.`
    : '';
  return `${address} is a wallet address on ${chainLabel}, not a token contract or a DeFi protocol, so it has no ${missing}.${held}`;
}
