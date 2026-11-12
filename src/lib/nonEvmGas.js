// Transaction fees on the two big chains that have no gas price in gwei:
// Solana (a fixed fee per signature plus an optional priority fee per compute
// unit) and Bitcoin (a fee rate in satoshis per virtual byte). Both read from
// free public endpoints with no key.
//
// Found live 2026-11: about a third of scored GAS_PRICE questions named
// Solana, and every one was refused because the EVM gas route has no Solana
// RPC.

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const MEMPOOL_FEES = 'https://mempool.space/api/v1/fees/recommended';
const TIMEOUT_MS = 6_000;

export const SOLANA_BASE_FEE_LAMPORTS = 5_000;
// A one-input, two-output native SegWit payment is about 141 virtual bytes.
export const BITCOIN_TYPICAL_VBYTES = 141;

const SOLANA_RE = /\b(solana|sol)\b/i;
const BITCOIN_RE = /\b(bitcoin|btc)\b/i;

export function nonEvmChain(text) {
  const t = String(text ?? '');
  if (SOLANA_RE.test(t)) return 'solana';
  if (BITCOIN_RE.test(t)) return 'bitcoin';
  return null;
}

async function withTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${new URL(url).host} returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

// Median and 75th percentile priority fee (micro-lamports per compute unit)
// over the recent slots the node reports, usually the last 150.
export async function fetchSolanaFees() {
  const body = await withTimeout(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: [] }),
  });
  const rows = Array.isArray(body?.result) ? body.result : [];
  if (!rows.length) throw new Error('Solana RPC returned no recent fees');
  const fees = rows.map((r) => Number(r.prioritizationFee) || 0).sort((a, b) => a - b);
  const slots = rows.map((r) => Number(r.slot)).filter(Number.isFinite);
  return {
    median: percentile(fees, 0.5),
    p75: percentile(fees, 0.75),
    slotsSampled: rows.length,
    latestSlot: slots.length ? Math.max(...slots) : null,
  };
}

const BLOCKSTREAM_FEES = 'https://blockstream.info/api/fee-estimates';

async function fromMempool() {
  const body = await withTimeout(MEMPOOL_FEES, { headers: { Accept: 'application/json' } });
  const fastest = Number(body?.fastestFee);
  if (!Number.isFinite(fastest)) throw new Error('mempool.space returned no fee rates');
  return {
    fastest,
    halfHour: Number(body.halfHourFee),
    hour: Number(body.hourFee),
    economy: Number(body.economyFee),
    minimum: Number(body.minimumFee),
    source: 'mempool.space',
  };
}

// Blockstream reports sat/vB keyed by confirmation target in blocks.
async function fromBlockstream() {
  const body = await withTimeout(BLOCKSTREAM_FEES, { headers: { Accept: 'application/json' } });
  const at = (n) => Math.round(Number(body?.[String(n)]) * 100) / 100;
  if (!Number.isFinite(at(1))) throw new Error('blockstream.info returned no fee rates');
  return { fastest: at(1), halfHour: at(3), hour: at(6), economy: at(144), minimum: at(1008), source: 'blockstream.info' };
}

// Either source alone has been unreachable at times (both seen failing from
// the host in 2026-11), so they race and the first good answer wins.
export async function fetchBitcoinFees() {
  return Promise.any([fromMempool(), fromBlockstream()]).catch(() => {
    throw new Error('mempool.space and blockstream.info both failed');
  });
}
