// ONCHAIN_METRIC_VERIFY signal endpoint: one value read straight from the
// chain at a named block (or the latest): a contract view such as owner(),
// totalAssets() or convertToShares(1e18), a price feed's latest round, a pool's
// slot0 or reserves, a raw storage slot, a native balance, or the gas a
// transaction used. The question is free text, so the contract, block, chain
// and the thing to read are all pulled out of it.

import { Router } from 'express';
import {
  ethCall, getStorageAt, getBalanceAt, getTransactionReceipt, withRpcBudget,
  RpcBudgetExceededError, ApiKeyMissingError,
} from '../lib/ankrRpc.js';
import { resolveRpcChainLoose, rpcChainNames, DEFAULT_CHAIN } from '../lib/chains.js';
import { extractTxHash, freeTextParam, firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { amountToDecimalString } from '../lib/formatAmount.js';
import { decodeLogs, withCommas } from '../lib/transferVerify.js';
import {
  addressesIn, blockFromText, slotFromText, explicitCalls, phraseCalls, completeArgs,
  encodeCall, signatureText, decodeResult, SUPPORTED_FUNCTIONS,
} from '../lib/onchainMetric.js';

const router = Router();

function chainFromText(text) {
  const cleaned = String(text ?? '').replace(/\bbase[\s-]*(?:fee|gas)\w*/gi, ' ').replace(/\bon[\s-]*chain\b/gi, ' ');
  return resolveRpcChainLoose(cleaned);
}

function blockLabel(block) {
  return block === 'latest' ? 'the latest block' : `block ${withCommas(block)}`;
}

async function readCalls(chain, contract, calls, block) {
  const segments = [];
  const fields = [];
  for (const call of calls) {
    const hex = await ethCall(chain.segment, contract, encodeCall(call), block).catch((err) => {
      // A revert means this contract has no such view. Anything else (a node
      // that lacks the old state, a timeout) must surface so the caller can
      // retry at the latest block instead of reporting "no such view".
      if (/revert|invalid opcode|out of gas|execution/i.test(String(err?.message))) return null;
      throw err;
    });
    let feedDecimals = null;
    if (call.name === 'latestRoundData' && hex) {
      const d = await ethCall(chain.segment, contract, '0x313ce567', block).catch(() => null);
      if (d && d !== '0x') feedDecimals = Number(BigInt(d));
    }
    const decoded = decodeResult(call.name, hex, { feedDecimals });
    if (!decoded) {
      segments.push(`${signatureText(call)} returned nothing (the contract has no such view, or it reverted at ${blockLabel(block)})`);
      continue;
    }
    segments.push(`${signatureText(call)} gave ${decoded.value}`);
    fields.push({ call: signatureText(call), value: decoded.value, ...decoded.fields });
  }
  return { segments, fields, ok: fields.length > 0 };
}

async function answer(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const text = freeTextParam(params) ?? '';

  const chainParam = firstUsableValue(params.chain, params.network, params.venue);
  let chain = chainParam ? resolveRpcChainLoose(String(chainParam)) : chainFromText(text);
  if (chainParam && !chain) {
    return respondUnusableInput(res, `${quoteParam(chainParam)} is not a chain I can read. I can read ${rpcChainNames().join(', ')}.`);
  }
  chain = chain ?? resolveRpcChainLoose(DEFAULT_CHAIN);

  const blockParam = firstUsableValue(params.block, params.block_number, params.blockNumber, params.height);
  const blockRaw = blockParam !== undefined && /^[\d,_]+$/.test(String(blockParam).trim()) ? String(blockParam).replace(/[,_]/g, '') : blockFromText(text);
  const block = blockRaw && !/^latest$/i.test(blockRaw) ? BigInt(blockRaw).toString() : 'latest';

  const addrParam = firstUsableValue(params.contract, params.address, params.contract_address, params.pool, params.vault, params.feed, params.token);
  const addresses = addressesIn(`${addrParam ?? ''} ${text}`);
  const contract = addresses[0] ?? null;
  const txHash = extractTxHash(text);

  const slot = firstUsableValue(params.slot, params.storage_slot) !== undefined
    ? `0x${BigInt(firstUsableValue(params.slot, params.storage_slot)).toString(16)}`
    : slotFromText(text);

  const note = { text: null };
  const run = async (fn) => {
    try {
      return await fn(block);
    } catch (err) {
      if (err instanceof RpcBudgetExceededError || err instanceof ApiKeyMissingError) throw err;
      if (block === 'latest') throw err;
      note.text = `Historical state at ${blockLabel(block)} was not available from the RPC, so this is the state at the latest block.`;
      return fn('latest');
    }
  };
  const reply = (summary, extra) => {
    const used = note.text ? 'latest' : block;
    res.json({
      status: 'ok',
      summary: `${summary}${note.text ? ` ${note.text}` : ''}`,
      confidence: note.text ? 0.4 : 0.95,
      canonical: ['onchain-metric-verify', chain.key, (contract ?? txHash ?? '').toLowerCase(), used, extra.kind].join(':'),
      chain: chain.key,
      contract,
      block: used,
      ...extra,
      source: `${chain.label} RPC at ${blockLabel(used)}`,
      checked_at: new Date().toISOString(),
    });
  };

  try {
    // 1. A raw storage slot.
    if (slot && contract) {
      const word = await run((b) => getStorageAt(chain.segment, contract, slot, b));
      const asInt = BigInt(word);
      const asAddr = word.slice(2, 26) === '0'.repeat(24) && asInt !== 0n ? ` Read as an address that word is 0x${word.slice(-40)}.` : '';
      return reply(
        `The 32-byte word stored at slot ${slot} of ${contract} on ${chain.label} at ${blockLabel(note.text ? 'latest' : block)} is ${word} (as an integer ${asInt}).${asAddr}`,
        { kind: 'storage', slot, value: word, value_integer: asInt.toString() },
      );
    }

    // 2. One or more contract views.
    if (contract) {
      let calls = explicitCalls(text);
      if (!calls.length) calls = phraseCalls(text);
      calls = calls.map((c) => completeArgs(c, text, contract)).filter(Boolean).slice(0, 4);
      if (calls.length) {
        const out = await run((b) => readCalls(chain, contract, calls, b));
        if (out.ok) {
          return reply(
            `On ${chain.label} at ${blockLabel(note.text ? 'latest' : block)}, the contract ${contract} answered: ${out.segments.join('; ')}.`,
            { kind: 'view', results: out.fields },
          );
        }
        return respondUnusableInput(res, `${contract} on ${chain.label} did not answer ${calls.map(signatureText).join(', ')}: it has no such view or it reverted. Check that the address is the right contract on this chain.`);
      }
    }

    // 3. Gas and logs of one transaction.
    if (txHash && /\b(?:gas|fee|events?|logs?)\b/i.test(text)) {
      const receipt = await getTransactionReceipt(chain.segment, txHash);
      if (!receipt) return respondUnusableInput(res, `No receipt exists for ${txHash} on ${chain.label}, so its gas and logs cannot be read.`);
      const gasUsed = BigInt(receipt.gasUsed);
      const price = BigInt(receipt.effectiveGasPrice ?? '0x0');
      const logs = receipt.logs?.length ?? 0;
      const transfers = decodeLogs(receipt.logs).length;
      return reply(
        `Transaction ${txHash} on ${chain.label} used ${withCommas(gasUsed)} gas (${gasUsed}) at an effective gas price of ${amountToDecimalString(price, 9)} gwei (${price} wei), a fee of ${amountToDecimalString(gasUsed * price, 18)} ${chain.nativeSymbol}, and emitted ${logs} log${logs === 1 ? '' : 's'}${transfers ? ` (${transfers} of them Transfer or Approval events)` : ''}, in block ${withCommas(BigInt(receipt.blockNumber))}.`,
        { kind: 'tx_gas', tx_hash: txHash, gas_used: gasUsed.toString(), effective_gas_price_wei: price.toString(), log_count: logs },
      );
    }

    // 4. A native balance.
    if (addresses.length && /\bbalance\b/i.test(text)) {
      const target = addresses[0];
      const wei = BigInt(await run((b) => getBalanceAt(chain.segment, target, b)));
      return reply(
        `The ${chain.nativeSymbol} balance of ${target} on ${chain.label} at ${blockLabel(note.text ? 'latest' : block)} is ${amountToDecimalString(wei, 18)} ${chain.nativeSymbol} (raw ${wei} wei).`,
        { kind: 'native_balance', address: target, value: amountToDecimalString(wei, 18), value_wei: wei.toString() },
      );
    }
  } catch (err) {
    if (err instanceof ApiKeyMissingError || err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'The on-chain read could not finish in time. Retry shortly.', confidence: 0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: `The ${chain.label} RPC did not answer. Retry shortly.`, confidence: 0, error: err.message });
  }

  return respondUnusableInput(res, `I could not tell which on-chain value to read. Give a contract address plus a view such as owner() or totalSupply() (known views: ${SUPPORTED_FUNCTIONS.slice(0, 12).join(', ')} and more), or a storage slot ("slot 0x8"), or a wallet for its native balance, or a transaction hash for its gas used. Add a block number to read history.`);
}

router.get('/', (req, res) => withRpcBudget(() => answer(req, res)));
router.post('/', (req, res) => withRpcBudget(() => answer(req, res)));

export default router;
