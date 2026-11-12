// P0 signal: direct circular funding (wallet sends back to its own
// funder). Strongest deterministic signal in the system, hash-provable,
// hard to fake by construction.
//
// Reference implementation to port from: telegraph-forensics-miner's
// src/lib/circularFunding.js `detectCircularFunding()`, specifically
// ONLY the direct one-hop check (`findOutboundMatch` / `scanNativeForMatch`
// / `scanTokenForMatch`). Do NOT port the second-hop intermediary trace
// (`findSecondHopOutboundMatch` / `collectOutboundCounterparties`) into
// the synchronous fast path. The old project's own instrumentation
// (scripts/caching-experiment.js, 2026-08-11) measured that trace at
// ~67% of all RPC calls for a real complex wallet while only ever
// producing PARTIAL-grade (circumstantial) evidence, never a hard
// conclusion. If second-hop circular funding gets built at all, it
// belongs in a deep/background tier, not here.
//
// BOUNDED DIFFERENTLY FROM THE OLD PROJECT: old MAX_PAGES was 25 per
// source (up to 2500 items), deliberately generous there because it was
// the single FAIL-capable signal. Sentinel's risk framing means an
// incomplete scan should downgrade confidence/coverage rather than block
// the whole response, so this can run with a shallower default cap for
// the fast tier and still report honestly via `complete: false`.

import { callAnkr } from '../rpc/client.js';
import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import { config } from '../../config.js';

const FAST_TIER_MAX_PAGES = 5;
const PAGE_SIZE = 100;

function normalizeMaxPages(value) {
  if (value === undefined) return FAST_TIER_MAX_PAGES;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError('maxPages must be a positive integer');
  }
  return Math.min(value, FAST_TIER_MAX_PAGES);
}

function blockNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Ankr's native tx status is EVM receipt-style ('0x1' success / '0x0'
// failure). Number() parses '0x1'/'0x0' hex strings directly. Missing
// status is treated as unproven, not success, since real responses
// always include it.
export function isSuccessStatus(status) {
  if (status === undefined || status === null || status === '') return false;
  if (typeof status === 'boolean') return status;
  const numeric = Number(status);
  return Number.isFinite(numeric) && numeric === 1;
}

// Requires strictly positive value so zero-value contract calls (e.g. a
// Safe execTransaction, where ETH moves internally rather than as the
// top-level call's value) never count as proof of a real transfer.
export function positiveBigInt(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

async function scanForMatch(wallet, funders, {
  method, listField, source, matcher, client, maxPages, chain,
}) {
  let pageToken;
  let pagesWalked = 0;

  do {
    const params = {
      blockchain: chain ?? config.chain,
      address: [wallet],
      pageSize: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    };
    const data = await client(method, params, {
      cacheKey: `${chain ?? config.chain}:${wallet.toLowerCase()}:${PAGE_SIZE}:${pageToken ?? ''}`,
      trace: {
        phase: 'circular',
        signal: 'direct_circular_funding',
        address: wallet,
        source,
        page: pagesWalked + 1,
        cursor: pageToken ?? null,
        pageCap: maxPages,
        relatedAddresses: [...funders],
      },
    });
    pagesWalked += 1;
    if (!data || !Array.isArray(data[listField])) {
      return { match: null, complete: false, pagesWalked, incompleteReason: 'malformed_rpc_result' };
    }
    const items = data[listField];
    const match = items.map(matcher).find((candidate) => candidate && funders.has(candidate.funder));
    if (match) return { match, complete: true, pagesWalked };

    pageToken = typeof data?.nextPageToken === 'string' && data.nextPageToken
      ? data.nextPageToken
      : undefined;
    if (!pageToken) return { match: null, complete: true, pagesWalked };
  } while (pagesWalked < maxPages);

  return { match: null, complete: false, pagesWalked, incompleteReason: 'page_cap_reached' };
}

/**
 * @param {string} wallet
 * @param {string[]} funderAddresses
 * @param {{ maxPages?: number, callAnkr?: typeof callAnkr, onCoverage?: (coverage: object) => void }} [opts]
 * @returns {Promise<import('../evidence/model.js').EvidenceItem | null>}
 */
export async function checkDirectCircularFunding(wallet, funderAddresses, opts = {}) {
  const funders = new Set(
    (Array.isArray(funderAddresses) ? funderAddresses : [])
      .filter((address) => typeof address === 'string' && address)
      .map((address) => address.toLowerCase())
  );
  if (funders.size === 0) {
    opts.onCoverage?.({ complete: true, pagesWalked: { native: 0, token: 0 } });
    return null;
  }

  const maxPages = normalizeMaxPages(opts.maxPages);
  const client = opts.callAnkr ?? callAnkr;
  const key = wallet.toLowerCase();
  const native = await scanForMatch(wallet, funders, {
    chain: opts.chain,
    method: 'ankr_getTransactionsByAddress',
    listField: 'transactions',
    source: 'native',
    // Require a successful, value-bearing top-level transfer. A contract
    // call by itself (e.g. calling into a Safe/multisig with value=0) is
    // not proof ETH actually moved to the funder.
    matcher: (tx) => {
      if (tx?.from?.toLowerCase() !== key || !tx?.to) return null;
      if (!isSuccessStatus(tx.status)) return null;
      const value = positiveBigInt(tx.value);
      if (value === null) return null;
      return {
        funder: tx.to.toLowerCase(),
        funderAddress: tx.to,
        txHash: tx.hash,
        blockNumber: blockNumber(tx.blockNumber),
        valueRaw: String(tx.value),
        rpcMethod: 'ankr_getTransactionsByAddress',
      };
    },
    client,
    maxPages,
  });

  let token = { match: null, complete: true, pagesWalked: 0 };
  if (!native.match) {
    token = await scanForMatch(wallet, funders, {
      chain: opts.chain,
      method: 'ankr_getTokenTransfers',
      listField: 'transfers',
      source: 'token',
      // ankr_getTokenTransfers has no per-transfer status field, but its
      // entries are decoded Transfer event logs, which are only ever
      // persisted for a transaction that succeeded (a revert rolls back
      // any logs emitted within it). A positive decoded value is
      // therefore itself sufficient proof real token movement happened.
      matcher: (transfer) => {
        if (transfer?.fromAddress?.toLowerCase() !== key || !transfer?.toAddress) return null;
        const value = positiveBigInt(transfer.valueRawInteger);
        if (value === null) return null;
        return {
          funder: transfer.toAddress.toLowerCase(),
          funderAddress: transfer.toAddress,
          txHash: transfer.transactionHash,
          blockNumber: blockNumber(transfer.blockHeight),
          valueRaw: String(transfer.valueRawInteger),
          tokenSymbol: transfer.tokenSymbol,
          rpcMethod: 'ankr_getTokenTransfers',
        };
      },
      client,
      maxPages,
    });
  }

  const match = native.match ?? token.match;
  const hasHighProvenance = Boolean(match?.txHash) && match?.blockNumber !== undefined;
  const complete = match ? hasHighProvenance : native.complete && token.complete;
  const incompleteReason = match && !hasHighProvenance
    ? 'missing_transaction_provenance'
    : native.incompleteReason ?? token.incompleteReason;
  opts.onCoverage?.({
    complete,
    pagesWalked: { native: native.pagesWalked, token: token.pagesWalked },
    ...(complete ? {} : { reason: incompleteReason }),
  });
  if (!match) return null;

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.DIRECT_CIRCULAR_FUNDING}:${key}:${match.funder}:${match.txHash ?? 'unknown'}`,
    signalCode: SIGNAL_CODES.DIRECT_CIRCULAR_FUNDING,
    polarity: hasHighProvenance ? 'risk' : 'contextual',
    strength: 'direct',
    addresses: [wallet, match.funderAddress],
    ...(match.txHash ? { txHashes: [match.txHash] } : {}),
    ...(match.blockNumber !== undefined ? { blockNumbers: [match.blockNumber] } : {}),
    rpcMethod: match.rpcMethod,
    asset: {
      ...(match.tokenSymbol ? { symbol: match.tokenSymbol } : {}),
      ...(match.valueRaw !== undefined ? { valueRaw: match.valueRaw } : {}),
      from: wallet,
      to: match.funderAddress,
    },
    derivationMethod: 'direct outbound native transaction or decoded token transfer from wallet to observed funder',
    complete: hasHighProvenance,
    ...(hasHighProvenance ? {} : { incompleteReason: 'missing_transaction_provenance' }),
    note: hasHighProvenance
      ? 'Observed a direct outbound transfer from the assessed wallet to its identified funder with transaction and block provenance.'
      : 'Observed an apparent direct outbound relationship to the identified funder, but missing transaction or block provenance prevents risk-bearing use.',
  });
}
