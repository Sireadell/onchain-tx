// P0 signal: direct funding relationship (who funded this wallet).
//
// Reference implementation to port from: telegraph-forensics-miner's
// src/lib/walletActivity.js `getEarliestFunder()` /
// `earliestFromNativeTransactions()` / `earliestFromTokenTransfers()`.
//
// KNOWN BUG TO CARRY FORWARD THE FIX FOR, NOT THE BUG: the old
// implementation had a real, live-caught bug where a raw transaction's
// `to` field for an ERC-20 transfer is always the token contract, never
// the real recipient. Funding that moves as an ERC-20 transfer never
// shows up via `tx.to === address` on the native tx list. Fixed
// 2026-07-23 by also walking the decoded token-transfer list separately.
// Keep both paths.
//
// BOUNDED DIFFERENTLY FROM THE OLD PROJECT: old MAX_PAGES was 10 per
// source (up to 1000 items). Per docs/LOCKED_SPEC.md's <10-15s p90
// target, this should default much shallower (e.g. 3 pages) for the fast
// tier, most agent wallets on this marketplace are only days old, so a
// shallow cap should still capture the true earliest funder for the vast
// majority of wallets. Report `complete: false` honestly when capped,
// don't silently trust a partial scan the way the old code's callers
// sometimes did.
//
// EARLIEST vs RELEVANT FUNDERS: collapsing to a single winning address
// here fed every downstream signal (circular-funding, fan-out,
// clustering) from that one address, so a wallet whose first-ever
// inbound transfer was a trivial gas top-up would have its *real*
// funder never checked at all (live-caught on a Ronin-exploiter-style
// wallet). `findEarliest` now keeps every qualifying candidate seen
// during the same bounded scan (no extra RPC cost, these items are
// already fetched) instead of discarding all but the minimum
// timestamp. `findDirectFunder` still reports the true chronological
// earliest as `asset.from` for backward-compatible provenance, but also
// exposes a small, bounded `relevantFunders` list that excludes
// native-asset dust (see NATIVE_DUST_THRESHOLD_WEI) so downstream
// signals can check the funder that actually matters, not just
// whichever arrived first.

import { callAnkr } from '../rpc/client.js';
import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import { config } from '../../config.js';
import { isSuccessStatus, positiveBigInt } from './circularFunding.js';

const FAST_TIER_MAX_PAGES = 3;
const PAGE_SIZE = 100;

// Downstream fan-out/clustering checks cost one full bounded RPC scan
// per relevant funder (see outboundRelationships.js), so this stays
// small and fixed rather than growing with however many distinct
// funders a wallet happens to have.
const MAX_RELEVANT_FUNDERS = 2;

// Deterministic, decimals-agnostic materiality rule: native transfers
// below this are treated as gas/dust top-ups, not a material funding
// relationship, unless nothing else qualifies. 0.01 ETH comfortably
// covers real-world gas-funding amounts (typically 0.001-0.01 ETH)
// without needing a price oracle. Token transfers are never classified
// as dust here -- ERC-20 decimals vary per contract, and resolving them
// would mean an extra RPC call per candidate; this is a documented
// scope limit, not a silent gap.
const NATIVE_DUST_THRESHOLD_WEI = 10_000_000_000_000_000n;

function isDustCandidate(candidate) {
  if (candidate.source !== 'native') return false;
  try {
    return BigInt(candidate.valueRaw) < NATIVE_DUST_THRESHOLD_WEI;
  } catch {
    return false;
  }
}

// Collapses multiple transfers from the same funder (across native and
// token sources, or repeat transfers on one source) into a single
// candidate, keeping whichever occurrence is earliest.
function dedupeByFunder(candidates) {
  const byFunder = new Map();
  for (const candidate of candidates) {
    const key = candidate.funder.toLowerCase();
    const existing = byFunder.get(key);
    if (!existing || candidate.timestamp < existing.timestamp) byFunder.set(key, candidate);
  }
  return [...byFunder.values()];
}

// First N distinct non-dust funders in chronological order. Falls back
// to the full (dust-included) pool only if every candidate is dust, so
// a wallet that has only ever received dust still gets a non-empty
// relevant-funder set rather than none at all.
function selectRelevantFunders(chronological) {
  const nonDust = chronological.filter((candidate) => !isDustCandidate(candidate));
  const pool = nonDust.length > 0 ? nonDust : chronological;
  const relevant = [];
  for (const candidate of pool) {
    if (relevant.some((address) => address.toLowerCase() === candidate.funder.toLowerCase())) continue;
    relevant.push(candidate.funder);
    if (relevant.length >= MAX_RELEVANT_FUNDERS) break;
  }
  return relevant;
}

function parseNativeTimestamp(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = raw.startsWith('0x') ? Number.parseInt(raw, 16) : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseTokenTimestamp(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseBlockNumber(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function normalizeMaxPages(value) {
  if (value === undefined) return FAST_TIER_MAX_PAGES;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('maxPages must be a positive integer');
  }
  return Math.min(value, FAST_TIER_MAX_PAGES);
}

async function findEarliest(wallet, { method, listField, source, isInbound, toCandidate, client, maxPages, descOrder, chain }) {
  const candidates = [];
  let pageToken;
  let pagesWalked = 0;
  let complete = false;
  let incompleteReason;

  do {
    const params = {
      blockchain: chain ?? config.chain,
      address: [wallet],
      pageSize: PAGE_SIZE,
      ...(descOrder !== undefined ? { descOrder } : {}),
      ...(pageToken ? { pageToken } : {}),
    };
    const data = await client(method, params, {
      cacheKey: `${chain ?? config.chain}:${wallet.toLowerCase()}:${PAGE_SIZE}:${pageToken ?? ''}`,
      trace: {
        phase: 'direct_funder',
        signal: 'funding_relationship',
        address: wallet,
        source,
        page: pagesWalked + 1,
        cursor: pageToken ?? null,
        pageCap: maxPages,
      },
    });
    pagesWalked += 1;

    if (!data || !Array.isArray(data[listField])) {
      incompleteReason = 'malformed_rpc_result';
      break;
    }
    const items = data[listField];
    for (const item of items) {
      if (!isInbound(item)) continue;
      const candidate = toCandidate(item);
      if (!candidate || candidate.timestamp === null || !candidate.funder) continue;
      candidate.source = source;
      candidates.push(candidate);
    }

    pageToken = typeof data?.nextPageToken === 'string' && data.nextPageToken
      ? data.nextPageToken
      : undefined;
    if (!pageToken) {
      complete = true;
      break;
    }
  } while (pagesWalked < maxPages);

  return {
    candidates,
    complete,
    pagesWalked,
    ...(!complete ? { incompleteReason: incompleteReason ?? 'page_cap_reached' } : {}),
  };
}

/**
 * @param {string} wallet
 * @param {{ maxPages?: number, callAnkr?: typeof callAnkr, onCoverage?: (coverage: object) => void }} [opts]
 * @returns {Promise<import('../evidence/model.js').EvidenceItem | null>}
 */
export async function findDirectFunder(wallet, opts = {}) {
  const maxPages = normalizeMaxPages(opts.maxPages);
  const client = opts.callAnkr ?? callAnkr;
  const key = wallet.toLowerCase();

  const [native, token] = await Promise.all([
    findEarliest(wallet, {
      method: 'ankr_getTransactionsByAddress',
      listField: 'transactions',
      source: 'native',
      // Ankr returns ankr_getTransactionsByAddress newest-first by
      // default (confirmed live against the API, undocumented). This
      // signal needs the wallet's earliest inbound transaction, so it
      // must walk oldest-first; without this, "earliest" within a
      // bounded page cap actually means "earliest among the most recent
      // N", which is wrong for any wallet with more native inbound
      // transfers than the page cap covers. ankr_getTokenTransfers
      // already defaults to oldest-first, so it doesn't need this.
      descOrder: false,
      // Require a successful, value-bearing transfer so a reverted or
      // zero-value inbound transaction can never be credited as the
      // wallet's funder (this identification feeds circular-funding's
      // funder check downstream).
      isInbound: (tx) => tx?.to?.toLowerCase() === key
        && isSuccessStatus(tx.status)
        && positiveBigInt(tx.value) !== null,
      toCandidate: (tx) => ({
        funder: tx.from,
        txHash: tx.hash,
        rpcMethod: 'ankr_getTransactionsByAddress',
        blockNumber: parseBlockNumber(tx.blockNumber),
        timestamp: parseNativeTimestamp(tx.timestamp),
        valueRaw: tx.value !== undefined ? String(tx.value) : '0',
      }),
      client,
      maxPages,
      chain: opts.chain,
    }),
    findEarliest(wallet, {
      method: 'ankr_getTokenTransfers',
      listField: 'transfers',
      source: 'token',
      isInbound: (transfer) => transfer?.toAddress?.toLowerCase() === key,
      toCandidate: (transfer) => ({
        funder: transfer.fromAddress,
        txHash: transfer.transactionHash,
        rpcMethod: 'ankr_getTokenTransfers',
        blockNumber: parseBlockNumber(transfer.blockNumber),
        timestamp: parseTokenTimestamp(transfer.timestamp),
        valueRaw: transfer.valueRawInteger !== undefined
          ? String(transfer.valueRawInteger)
          : '0',
        tokenSymbol: transfer.tokenSymbol,
      }),
      client,
      maxPages,
      chain: opts.chain,
    }),
  ]);

  const complete = native.complete && token.complete;
  const incompleteReason = native.incompleteReason ?? token.incompleteReason;
  opts.onCoverage?.({
    complete,
    pagesWalked: { native: native.pagesWalked, token: token.pagesWalked },
    ...(complete ? {} : { reason: incompleteReason }),
  });

  // Native candidates are concatenated first so a tied timestamp (same
  // instant, two sources) keeps the pre-existing native-wins tie-break
  // behavior once sorted (Array#sort is stable).
  const allCandidates = [...native.candidates, ...token.candidates];
  if (allCandidates.length === 0) return null;
  const chronological = dedupeByFunder(allCandidates).sort((a, b) => a.timestamp - b.timestamp);
  const earliest = chronological[0];
  const relevantFunders = selectRelevantFunders(chronological);
  const extraAddresses = relevantFunders.filter(
    (address) => address.toLowerCase() !== earliest.funder.toLowerCase()
  );
  const addresses = [wallet, earliest.funder, ...extraAddresses];

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.DIRECT_FUNDER}:${key}:${earliest.funder.toLowerCase()}:${earliest.txHash ?? 'unknown'}`,
    signalCode: SIGNAL_CODES.DIRECT_FUNDER,
    polarity: 'contextual',
    strength: 'direct',
    addresses,
    ...(earliest.txHash ? { txHashes: [earliest.txHash] } : {}),
    ...(earliest.blockNumber !== undefined ? { blockNumbers: [earliest.blockNumber] } : {}),
    rpcMethod: earliest.rpcMethod,
    asset: {
      ...(earliest.tokenSymbol ? { symbol: earliest.tokenSymbol } : {}),
      valueRaw: earliest.valueRaw,
      from: earliest.funder,
      to: wallet,
      timestamp: earliest.timestamp,
    },
    // Bounded (see MAX_RELEVANT_FUNDERS) set of addresses downstream
    // signals (circular-funding, fan-out, clustering) should check,
    // excluding native-asset dust that isn't the wallet's only funder.
    // Always non-empty when this evidence item exists.
    relevantFunders,
    metrics: {
      candidateCount: chronological.length,
      relevantFunderCount: relevantFunders.length,
      earliestIsDust: isDustCandidate(earliest),
    },
    relationships: chronological.map((candidate) => ({
      funder: candidate.funder,
      role: candidate.funder.toLowerCase() === earliest.funder.toLowerCase()
        ? 'earliest'
        : relevantFunders.some((address) => address.toLowerCase() === candidate.funder.toLowerCase())
          ? 'relevant'
          : 'observed',
      source: candidate.source,
      ...(candidate.txHash ? { txHash: candidate.txHash } : {}),
      ...(candidate.blockNumber !== undefined ? { blockNumber: candidate.blockNumber } : {}),
      ...(candidate.tokenSymbol ? { symbol: candidate.tokenSymbol } : {}),
      valueRaw: candidate.valueRaw,
      timestamp: candidate.timestamp,
      dust: isDustCandidate(candidate),
    })),
    derivationMethod: 'earliest inbound native transaction or decoded token transfer within bounded history, retaining every qualifying candidate to derive a bounded set of materially relevant funders',
    complete,
    ...(complete ? {} : { incompleteReason }),
    note: 'Observed earliest inbound transfer identifies a direct funder; this relationship is contextual and is not risk-bearing on its own. relevantFunders additionally excludes native gas/dust top-ups so downstream checks target materially significant funders.',
  });
}
