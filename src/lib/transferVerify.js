// Pure helpers for CRYPTO_TRANSFER_VERIFY: fee split, confirmations and
// token-movement decoding from a transaction receipt. No network calls, so
// every rule here is testable against fixed receipts.

import { amountToDecimalString } from './formatAmount.js';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
export const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const MAX_UINT256 = (1n << 256n) - 1n;

const big = (hex) => {
  if (hex === undefined || hex === null || hex === '0x' || hex === '') return 0n;
  try { return BigInt(hex); } catch { return 0n; }
};

export function withCommas(value) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const topicAddress = (topic) => `0x${String(topic).slice(-40).toLowerCase()}`;

// Fee paid by the sender, split into the burned base-fee part and the tip,
// plus the optional L1 data fee (OP-stack receipts) and blob fee (type-3).
export function computeFee({ tx, receipt, block, nativeDecimals = 18 }) {
  const gasUsed = big(receipt?.gasUsed);
  const effective = big(receipt?.effectiveGasPrice ?? tx?.gasPrice);
  const execution = gasUsed * effective;
  const baseFeePerGas = block?.baseFeePerGas ? big(block.baseFeePerGas) : null;
  const burned = baseFeePerGas === null ? null : gasUsed * baseFeePerGas;
  const tip = burned === null ? null : (execution > burned ? execution - burned : 0n);
  const l1Fee = receipt?.l1Fee ? big(receipt.l1Fee) : 0n;
  const blobGasUsed = receipt?.blobGasUsed ? big(receipt.blobGasUsed) : 0n;
  const blobGasPrice = receipt?.blobGasPrice ? big(receipt.blobGasPrice) : 0n;
  const blobFee = blobGasUsed * blobGasPrice;
  const total = execution + l1Fee + blobFee;
  const dec = (v) => (v === null ? null : amountToDecimalString(v, nativeDecimals));
  return {
    gas_used: gasUsed.toString(),
    gas_limit: tx?.gas ? big(tx.gas).toString() : null,
    effective_gas_price_wei: effective.toString(),
    effective_gas_price_gwei: amountToDecimalString(effective, 9),
    base_fee_per_gas_wei: baseFeePerGas === null ? null : baseFeePerGas.toString(),
    execution_fee_wei: execution.toString(),
    burned_wei: burned === null ? null : burned.toString(),
    burned: dec(burned),
    tip_wei: tip === null ? null : tip.toString(),
    tip: dec(tip),
    l1_fee_wei: l1Fee > 0n ? l1Fee.toString() : null,
    blob_gas_used: blobGasUsed > 0n ? blobGasUsed.toString() : null,
    blob_gas_price_wei: blobGasUsed > 0n ? blobGasPrice.toString() : null,
    blob_fee_wei: blobGasUsed > 0n ? blobFee.toString() : null,
    total_fee_wei: total.toString(),
    total_fee: dec(total),
  };
}

// Counting the inclusion block as the first confirmation: tip - block + 1.
export function confirmationsAt(txBlock, tipBlock) {
  const n = BigInt(tipBlock) - BigInt(txBlock) + 1n;
  return n > 0n ? n : 0n;
}

export function formatDuration(seconds) {
  let s = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hours = Math.floor(s / 3600); s -= hours * 3600;
  const minutes = Math.floor(s / 60); s -= minutes * 60;
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours || days) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (!days && !hours) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

// Decodes the Transfer / Approval / TransferSingle logs of one receipt.
// ERC-20 Transfers carry 3 topics and a 32-byte amount; ERC-721 Transfers
// carry 4 topics (the token id is the last topic).
export function decodeLogs(logs) {
  const out = [];
  for (const log of logs ?? []) {
    const topics = log.topics ?? [];
    const data = String(log.data ?? '0x');
    const token = String(log.address ?? '').toLowerCase();
    if (topics[0] === TRANSFER_TOPIC && topics.length === 3 && data.length >= 66) {
      out.push({ kind: 'erc20_transfer', token, from: topicAddress(topics[1]), to: topicAddress(topics[2]), amount: big(data.slice(0, 66)) });
    } else if (topics[0] === TRANSFER_TOPIC && topics.length === 4) {
      out.push({ kind: 'nft_transfer', token, from: topicAddress(topics[1]), to: topicAddress(topics[2]), token_id: big(topics[3]) });
    } else if (topics[0] === APPROVAL_TOPIC && topics.length === 3 && data.length >= 66) {
      out.push({ kind: 'approval', token, owner: topicAddress(topics[1]), spender: topicAddress(topics[2]), amount: big(data.slice(0, 66)) });
    } else if (topics[0] === TRANSFER_SINGLE_TOPIC && topics.length === 4 && data.length >= 130) {
      out.push({ kind: 'erc1155_transfer', token, from: topicAddress(topics[2]), to: topicAddress(topics[3]), token_id: big(`0x${data.slice(2, 66)}`), amount: big(`0x${data.slice(66, 130)}`) });
    }
  }
  return out;
}

export function isUnlimited(amount) {
  return amount === MAX_UINT256;
}

// Native-currency moves made by contracts inside one transaction, read from
// a callTracer call tree. The top-level call is the transaction's own value
// and is skipped; calls that failed, and everything beneath a failed call,
// moved nothing and are skipped too. Delegate and static calls carry no value.
const VALUE_CALL_TYPES = new Set(['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT']);
export function internalTransfers(trace) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || node.error) return;
    if (depth > 0 && VALUE_CALL_TYPES.has(String(node.type ?? 'CALL').toUpperCase())) {
      const value = big(node.value);
      if (value > 0n) out.push({ from: String(node.from ?? '').toLowerCase(), to: String(node.to ?? '').toLowerCase(), value });
    }
    for (const child of node.calls ?? []) walk(child, depth + 1);
  };
  walk(trace, 0);
  return out;
}
