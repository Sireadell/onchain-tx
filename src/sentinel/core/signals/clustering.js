// P0 signal: bounded, per-request blockchain-only funding clusters.
//
// This does not use reporters or persistence. Distinct evidence means
// distinct direct blockchain edges, while cluster size means distinct
// recipient wallets. It is contextual only and never changes risk by itself.
//
// Also covers same-funder burst-timing and amount-uniformity detail (the
// scoped-down version of the roadmap's "temporal/amount correlation"
// items, see docs/LOCKED_SPEC.md). The original design for those items
// required a persisted, cross-request store of every wallet ever assessed
// so it could catch DIFFERENT funders paying out in a correlated way
// (see the frozen reference implementation, telegraph-forensics-miner's
// src/lib/clustering.js `recordAndCountCorrelatedFunding()`, which
// documents its own reporter-poisoning attack surface). Sentinel
// deliberately has no such store, so this only detects the SAME funder's
// payouts being suspiciously fast or suspiciously uniform in amount --
// it does NOT catch a Sybil operator using many different funder
// addresses. That harder case is deferred, not silently dropped: it
// needs a persistence decision this project hasn't made. Folded into the
// existing FUNDING_CLUSTER evidence item (extra metrics/note detail)
// rather than a separate signal, since it reuses the exact same edge
// list already fetched for clustering -- a separate evidence item would
// almost always co-fire with FUNDING_CLUSTER on the same data.

import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import { observeDirectOutbound, deduplicateDirectEdges } from './outboundRelationships.js';

const BURST_WINDOW_SECONDS = 600; // 10 minutes
const AMOUNT_TOLERANCE_BPS = 200n; // 2%

const BURST_MIN_RECIPIENTS = 3;
const AMOUNT_UNIFORMITY_MIN_RECIPIENTS = 3;

// One representative edge per distinct recipient: the earliest edge seen
// for that recipient in the (already deduplicated) edge list. Burst
// timing and amount uniformity are both judged off this one edge per
// recipient, not every edge, so a recipient funded twice can't inflate
// either count on its own.
function representativeEdgePerRecipient(edges) {
  const byRecipient = new Map();
  for (const edge of edges) {
    if (edge.timestamp === null || edge.timestamp === undefined) continue;
    const key = edge.to.toLowerCase();
    const existing = byRecipient.get(key);
    if (!existing || edge.timestamp < existing.timestamp) byRecipient.set(key, edge);
  }
  return [...byRecipient.values()];
}

// True if BURST_MIN_RECIPIENTS or more distinct recipients were first
// funded within a BURST_WINDOW_SECONDS window of each other -- a burst of
// payouts, not funding spread out over time.
function detectBurst(representativeEdges) {
  if (representativeEdges.length < BURST_MIN_RECIPIENTS) return false;
  const timestamps = representativeEdges.map((edge) => edge.timestamp).sort((a, b) => a - b);
  for (let i = 0; i + BURST_MIN_RECIPIENTS - 1 < timestamps.length; i += 1) {
    const windowSpan = timestamps[i + BURST_MIN_RECIPIENTS - 1] - timestamps[i];
    if (windowSpan <= BURST_WINDOW_SECONDS) return true;
  }
  return false;
}

// True if AMOUNT_UNIFORMITY_MIN_RECIPIENTS or more distinct recipients
// received amounts within AMOUNT_TOLERANCE_BPS of each other -- e.g. every
// wallet funded with ~the same 0.05 ETH. Recipients with no decoded
// amount are excluded rather than treated as a match.
function detectAmountUniformity(representativeEdges) {
  const amounts = representativeEdges
    .map((edge) => edge.valueRaw)
    .filter((value) => value !== undefined && value !== null)
    .map((value) => BigInt(value))
    .filter((value) => value > 0n)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (amounts.length < AMOUNT_UNIFORMITY_MIN_RECIPIENTS) return false;
  for (let i = 0; i + AMOUNT_UNIFORMITY_MIN_RECIPIENTS - 1 < amounts.length; i += 1) {
    const low = amounts[i];
    const high = amounts[i + AMOUNT_UNIFORMITY_MIN_RECIPIENTS - 1];
    if (low === 0n) continue;
    const spreadBps = ((high - low) * 10000n) / low;
    if (spreadBps <= AMOUNT_TOLERANCE_BPS) return true;
  }
  return false;
}

function relationshipFromRecord(record) {
  return {
    from: record.from,
    to: record.to,
    ...(record.txHash ? { txHash: record.txHash } : {}),
    ...(record.logIndex !== undefined ? { logIndex: record.logIndex } : {}),
    ...(record.blockNumber !== undefined ? { blockNumber: record.blockNumber } : {}),
    ...(record.blockHash ? { blockHash: record.blockHash } : {}),
    rpcMethod: record.rpcMethod,
    asset: {
      ...(record.symbol ? { symbol: record.symbol } : {}),
      ...(record.assetAddress ? { address: record.assetAddress } : {}),
      ...(record.valueRaw !== undefined ? { valueRaw: record.valueRaw } : {}),
      ...(record.timestamp !== null ? { timestamp: record.timestamp } : {}),
    },
  };
}

/**
 * @param {string} funderAddress
 * @param {string} wallet
 * @param {{ maxPages?: number, callAnkr?: Function, onCoverage?: (coverage: object) => void }} [opts]
 * @returns {Promise<import('../evidence/model.js').EvidenceItem | null>}
 */
export async function recordAndGetFundingCluster(funderAddress, wallet, opts = {}) {
  if (!funderAddress) {
    opts.onCoverage?.({ complete: true, pagesWalked: { native: 0, token: 0 }, clusterSize: 0 });
    return null;
  }
  const observation = opts.observation ?? await observeDirectOutbound(funderAddress, opts);
  const edges = deduplicateDirectEdges(observation.records);
  const members = new Map();
  for (const edge of edges) {
    const key = edge.to.toLowerCase();
    if (!members.has(key)) members.set(key, edge.to);
  }
  const clusterSize = members.size;
  opts.onCoverage?.({
    complete: observation.complete,
    pagesWalked: observation.pagesWalked,
    clusterSize,
    supportingEdgeCount: edges.length,
    ...(observation.complete ? {} : { reason: observation.incompleteReason }),
  });
  if (clusterSize < 2) return null;

  const representativeEdges = representativeEdgePerRecipient(edges);
  const burstDetected = detectBurst(representativeEdges);
  const amountUniformityDetected = detectAmountUniformity(representativeEdges);

  const txHashes = [...new Set(edges.map((edge) => edge.txHash).filter(Boolean))];
  const blockNumbers = [...new Set(
    edges.map((edge) => edge.blockNumber).filter((value) => value !== undefined)
  )];
  const cutoff = edges
    .filter((edge) => edge.blockNumber !== undefined)
    .reduce((latest, edge) => !latest || edge.blockNumber > latest.blockNumber ? edge : latest, null);
  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.FUNDING_CLUSTER}:${funderAddress.toLowerCase()}:${clusterSize}:${cutoff?.txHash ?? 'unknown'}`,
    signalCode: SIGNAL_CODES.FUNDING_CLUSTER,
    polarity: 'contextual',
    strength: 'one_hop',
    addresses: [funderAddress, ...members.values()],
    ...(txHashes.length ? { txHashes } : {}),
    ...(blockNumbers.length ? { blockNumbers } : {}),
    ...(cutoff ? {
      observationCutoff: {
        block: cutoff.blockNumber,
        ...(cutoff.blockHash ? { hash: cutoff.blockHash } : {}),
      },
    } : {}),
    rpcMethod: 'ankr_getTransactionsByAddress+ankr_getTokenTransfers',
    metrics: {
      clusterSize,
      supportingEdgeCount: edges.length,
      burstDetected,
      burstWindowSeconds: BURST_WINDOW_SECONDS,
      amountUniformityDetected,
      amountToleranceBps: Number(AMOUNT_TOLERANCE_BPS),
    },
    relationships: edges.map(relationshipFromRecord),
    derivationMethod: 'distinct direct recipients observed in the bounded outbound history of the assessed wallet direct funder, with same-funder burst-timing and amount-uniformity detail computed off the same edge list',
    complete: observation.complete,
    ...(observation.complete ? {} : { incompleteReason: observation.incompleteReason }),
    note: `Observed ${clusterSize} distinct wallets receiving direct transfers from the same funder${wallet ? ` associated with ${wallet}` : ''}.`
      + (burstDetected ? ` At least ${BURST_MIN_RECIPIENTS} of them were first funded within a ${BURST_WINDOW_SECONDS}-second window of each other.` : '')
      + (amountUniformityDetected ? ` At least ${AMOUNT_UNIFORMITY_MIN_RECIPIENTS} of them received near-identical amounts (within ${Number(AMOUNT_TOLERANCE_BPS) / 100}%).` : '')
      + ' This reflects only funding paid out by this one funder; it cannot detect a Sybil operator using multiple different funder addresses. This is contextual and does not imply common ownership, coordination, Sybil behavior, or fraud.',
  });
}
