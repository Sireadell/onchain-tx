// CRYPTO_TRANSFER_VERIFY signal endpoint: the full audit of one on-chain
// transfer. It answers the outcome, both parties, the amount (native value and
// every token movement in the receipt), the fee split into the burned and tip
// parts, and the confirmation count, all read from the receipt and block
// header. Graded questions arrive as free text and often name a "tip" block to
// count confirmations from ("treat 280,000,000 as the chain tip"), so that is
// read out of the text too.

import { Router } from 'express';
import {
  getTransactionByHash, getTransactionReceipt, getBlockNumber, getBlockByNumber, withRpcBudget,
  RpcBudgetExceededError, ApiKeyMissingError,
} from '../lib/ankrRpc.js';
import { resolveRpcChainLoose, rpcChainNames, DEFAULT_CHAIN } from '../lib/chains.js';
import { extractTxHash, freeTextParam, firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { amountToDecimalString } from '../lib/formatAmount.js';
import { readTokenMeta } from '../lib/knownTokens.js';
import {
  computeFee, confirmationsAt, formatDuration, decodeLogs, isUnlimited, withCommas,
} from '../lib/transferVerify.js';

const router = Router();

const NUM = String.raw`(\d{1,3}(?:[,_]\d{3})+|\d{5,})`;
const TIP_PATTERNS = [
  new RegExp(String.raw`\b(?:as of|from|treat|tip(?: is| of)?|height|current block|latest block|counting from|measured? (?:at|from|against))\s+(?:block\s+)?(?:number\s+)?#?${NUM}`, 'i'),
  new RegExp(String.raw`\bblock(?:\s+(?:number|height))?\s*#?\s*${NUM}`, 'i'),
  new RegExp(String.raw`${NUM}\s+as\s+the\s+(?:chain\s+)?(?:tip|head|latest)`, 'i'),
];

// The block to count confirmations against, when the question names one.
export function tipBlockFromText(text) {
  const clean = String(text ?? '').replace(/0x[0-9a-fA-F]{20,}/g, ' ');
  for (const re of TIP_PATTERNS) {
    const m = clean.match(re);
    if (m) return m[1].replace(/[,_]/g, '');
  }
  return null;
}

// "base-fee" must not be read as the Base chain.
function chainFromText(text) {
  const cleaned = String(text ?? '').replace(/\bbase[\s-]*(?:fee|gas)\w*/gi, ' ').replace(/\bon[\s-]*chain\b/gi, ' ');
  return resolveRpcChainLoose(cleaned);
}

async function findTransaction(chain, txHash, explicit) {
  const [tx, receipt] = await Promise.all([
    getTransactionByHash(chain.segment, txHash),
    getTransactionReceipt(chain.segment, txHash),
  ]);
  if (tx || explicit) return { chain, tx, receipt };
  // No chain was named and Ethereum does not know the hash: ask the others.
  const others = rpcChainNames().filter((name) => name !== chain.key).map((name) => resolveRpcChainLoose(name)).filter(Boolean);
  const probes = await Promise.allSettled(others.map(async (c) => ({ chain: c, tx: await getTransactionByHash(c.segment, txHash) })));
  const hit = probes.map((p) => (p.status === 'fulfilled' ? p.value : null)).find((p) => p?.tx);
  if (!hit) return { chain, tx: null, receipt: null };
  const found = await getTransactionReceipt(hit.chain.segment, txHash);
  return { chain: hit.chain, tx: hit.tx, receipt: found };
}

async function tokenLabels(chain, decoded) {
  const addresses = [...new Set(decoded.filter((d) => d.kind !== 'nft_transfer').map((d) => d.token))].slice(0, 6);
  const metas = await Promise.all(addresses.map((a) => readTokenMeta(chain, a).catch(() => null)));
  return Object.fromEntries(addresses.map((a, i) => [a, metas[i]]));
}

function describeMovements(decoded, metas) {
  const lines = [];
  const transfers = decoded.filter((d) => d.kind === 'erc20_transfer' || d.kind === 'nft_transfer' || d.kind === 'erc1155_transfer');
  const approvals = decoded.filter((d) => d.kind === 'approval');
  const amountText = (d) => {
    const meta = metas[d.token];
    if (!meta) return `${withCommas(d.amount)} raw units`;
    return `${amountToDecimalString(d.amount, meta.decimals)} ${meta.symbol}`;
  };
  transfers.slice(0, 12).forEach((d, i) => {
    if (d.kind === 'nft_transfer') lines.push(`${i + 1}) NFT id ${d.token_id} of ${d.token} from ${d.from} to ${d.to}`);
    else if (d.kind === 'erc1155_transfer') lines.push(`${i + 1}) ${d.amount} of token id ${d.token_id} (${d.token}) from ${d.from} to ${d.to}`);
    else lines.push(`${i + 1}) ${amountText(d)} from ${d.from} to ${d.to}`);
  });
  const out = [];
  if (transfers.length) out.push(`${transfers.length} Transfer event${transfers.length === 1 ? '' : 's'} in log order: ${lines.join('; ')}.`);
  for (const a of approvals.slice(0, 4)) {
    const meta = metas[a.token];
    const unit = meta?.symbol ?? 'raw units';
    const what = isUnlimited(a.amount) ? `an unlimited allowance (2^256-1 raw units of ${unit})` : amountText(a);
    out.push(`Approval: ${a.owner} allowed ${a.spender} to spend ${what} (token contract ${a.token}).`);
  }
  return out.join(' ');
}

export function buildTransferSummary({ chain, txHash, tx, receipt, fee, valueWei, movementsText, confirmations, tip, elapsedText, blockNumber }) {
  const succeeded = receipt.status !== '0x0';
  const nat = chain.nativeSymbol;
  const parts = [];
  parts.push(`The transaction ${txHash} ${succeeded ? 'succeeded (status 1)' : 'failed (status 0) and was reverted'} in block ${withCommas(blockNumber)} on ${chain.label}.`);
  const to = tx.to ?? (receipt.contractAddress ? `the new contract ${receipt.contractAddress}` : 'a contract creation');
  parts.push(`Sender ${tx.from}; recipient ${to}.`);
  if (tx.to === null || tx.to === undefined) {
    if (receipt.contractAddress) parts.push(`Contract deployment: the new contract lives at ${receipt.contractAddress}.`);
  }
  const valueEth = amountToDecimalString(valueWei, 18);
  parts.push(valueWei === 0n ? `No native ${nat} was sent (value 0).` : `Native amount transferred: ${valueEth} ${nat} (raw ${valueWei} wei).`);
  if (movementsText) parts.push(movementsText);
  let feeText = `Total fee: ${fee.total_fee} ${nat} (${withCommas(fee.total_fee_wei)} wei), from ${withCommas(fee.gas_used)} gas used at an effective gas price of ${fee.effective_gas_price_gwei} gwei (${withCommas(fee.effective_gas_price_wei)} wei).`;
  if (fee.burned_wei !== null) {
    feeText += ` Burned base fee: ${withCommas(fee.burned_wei)} wei (${fee.burned} ${nat}) from the block's base fee of ${fee.base_fee_per_gas_wei} wei; priority tip paid: ${withCommas(fee.tip_wei)} wei (${fee.tip} ${nat}).`;
  }
  if (fee.l1_fee_wei) feeText += ` Layer-1 data fee included: ${withCommas(fee.l1_fee_wei)} wei.`;
  if (fee.blob_fee_wei) feeText += ` Blob fee: ${withCommas(fee.blob_fee_wei)} wei (${withCommas(fee.blob_gas_used)} blob gas at ${fee.blob_gas_price_wei} wei).`;
  parts.push(feeText);
  const against = tip.given ? `against block ${withCommas(tip.number)}` : `against the latest block ${withCommas(tip.number)}`;
  parts.push(`Confirmations: ${withCommas(confirmations)} counted ${against}, with the inclusion block as the first confirmation.${elapsedText ? ` ${elapsedText}` : ''}`);
  return parts.join(' ');
}

async function handleTransferVerify(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const text = freeTextParam(params) ?? '';
  const rawHash = firstUsableValue(params.tx_hash, params.hash, params.transaction, params.txid, text);
  const txHash = extractTxHash(String(rawHash ?? '')) ?? extractTxHash(text);
  if (!txHash) {
    return respondUnusableInput(res, `I cannot verify a transfer because ${rawHash ? `${quoteParam(rawHash)} contains no transaction hash` : 'no transaction hash was supplied'}. A transaction hash is "0x" followed by 64 hexadecimal characters; pass it as tx_hash and I will report the outcome, parties, amount, fee and confirmations.`);
  }

  const chainParam = firstUsableValue(params.chain, params.network, params.venue);
  let chain = chainParam ? resolveRpcChainLoose(String(chainParam)) : chainFromText(text);
  const explicit = Boolean(chain);
  if (chainParam && !chain) {
    return respondUnusableInput(res, `I cannot verify this transfer because ${quoteParam(chainParam)} is not a chain I can read. I can read ${rpcChainNames().join(', ')}.`);
  }
  chain = chain ?? resolveRpcChainLoose(DEFAULT_CHAIN);

  const tipParam = firstUsableValue(params.tip_block, params.as_of_block, params.block, params.block_number);
  const tipText = tipParam !== undefined && /^[\d,_]+$/.test(String(tipParam).trim()) ? String(tipParam).replace(/[,_]/g, '') : tipBlockFromText(text);

  try {
    const found = await findTransaction(chain, txHash, explicit);
    const { tx, receipt } = found;
    chain = found.chain;
    if (!tx) {
      return res.json({
        status: 'not_found',
        summary: `No transaction ${txHash} exists on ${explicit ? chain.label : 'any chain I can read'} (${rpcChainNames().join(', ')}), so no transfer can be verified.`,
        confidence: 0.9,
        canonical: ['crypto-transfer-verify', chain.key, txHash.toLowerCase(), 'not_found'].join(':'),
        tx_hash: txHash,
      });
    }
    if (!receipt || tx.blockNumber == null) {
      return res.json({
        status: 'pending',
        summary: `The transaction ${txHash} is known on ${chain.label} but has not been mined yet, so it has no outcome, fee or confirmations.`,
        confidence: 0.5,
        canonical: ['crypto-transfer-verify', chain.key, txHash.toLowerCase(), 'pending'].join(':'),
        tx_hash: txHash,
        from: tx.from,
        to: tx.to,
      });
    }

    const blockNumber = BigInt(receipt.blockNumber);
    const [block, latestHex] = await Promise.all([
      getBlockByNumber(chain.segment, blockNumber).catch(() => null),
      tipText ? Promise.resolve(null) : getBlockNumber(chain.segment).catch(() => null),
    ]);
    const tipNumber = tipText ? BigInt(tipText) : (latestHex ? BigInt(latestHex) : blockNumber);
    let elapsedText = '';
    let elapsedSeconds = null;
    if (tipText && block?.timestamp) {
      const tipBlock = await getBlockByNumber(chain.segment, tipNumber).catch(() => null);
      if (tipBlock?.timestamp) {
        elapsedSeconds = Number(BigInt(tipBlock.timestamp) - BigInt(block.timestamp));
        elapsedText = `Elapsed between the two blocks' timestamps: ${withCommas(elapsedSeconds)} seconds (${formatDuration(elapsedSeconds)}).`;
      }
    }

    const decoded = decodeLogs(receipt.logs);
    const metas = await tokenLabels(chain, decoded);
    const fee = computeFee({ tx, receipt, block });
    const valueWei = BigInt(tx.value ?? '0x0');
    const confirmations = confirmationsAt(blockNumber, tipNumber);
    const movementsText = describeMovements(decoded, metas);
    const summary = buildTransferSummary({
      chain, txHash, tx, receipt, fee, valueWei, movementsText, confirmations,
      tip: { given: Boolean(tipText), number: tipNumber }, elapsedText, blockNumber,
    });
    const reverted = receipt.status === '0x0';

    res.json({
      status: reverted ? 'reverted' : 'confirmed',
      summary,
      confidence: confirmations >= 12n ? 0.97 : 0.8,
      canonical: ['crypto-transfer-verify', chain.key, txHash.toLowerCase(), reverted ? 'reverted' : 'confirmed', blockNumber.toString()].join(':'),
      tx_hash: txHash,
      chain: chain.key,
      from: tx.from,
      to: tx.to,
      contract_created: receipt.contractAddress ?? null,
      block_number: blockNumber.toString(),
      value_wei: valueWei.toString(),
      value: amountToDecimalString(valueWei, 18),
      fee,
      confirmations: confirmations.toString(),
      confirmations_counted_against: tipNumber.toString(),
      elapsed_seconds: elapsedSeconds,
      token_events: decoded.length,
      source: `${chain.label} RPC receipt and block header`,
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof ApiKeyMissingError || err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'The transfer check could not finish in time. Retry shortly.', confidence: 0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'The chain RPC did not answer for this transfer. Retry shortly.', confidence: 0, error: err.message });
  }
}

router.get('/', (req, res) => withRpcBudget(() => handleTransferVerify(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleTransferVerify(req, res)));

export default router;
