// P0 signal: funder fan-out (funder behaves like an exchange / payment
// processor). CIRCUMSTANTIAL ONLY, see docs/LOCKED_SPEC.md hard
// constraint: this must never independently produce HIGH risk.
//
// Reference implementation to port from: telegraph-forensics-miner's
// src/lib/knownExchanges.js `analyzeFunderFanOut()`.
//
// REAL BUG IN THE OLD PROJECT, DO NOT REPEAT: old scoring.js's
// decideVerdict() let `onChainFanOutCount >= FAIL_CLUSTER_THRESHOLD`
// independently cause a hard FAIL. A legitimate treasury/paymaster wallet
// funding many real team-operated agents looks identical to a Sybil
// farmer on this signal alone. It is real signal, but only ever as
// circumstantial/corroborating evidence (see
// core/evidence/model.js CIRCUMSTANTIAL_ONLY_CODES and
// core/scoring/index.js assertFanOutNotSoleBasisForHigh).
//
// Second-hop fan-out (tracing the funder's own funder) from the old
// project is explicitly OUT for the fast tier, expensive (a whole extra
// funder lookup + fan-out walk) for weak, two-hops-removed evidence. Deep
// tier only, if built at all.

import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import {
  observeDirectOutbound,
  deduplicateDirectEdges,
  OUTBOUND_MAX_PAGES,
} from './outboundRelationships.js';

const FAST_TIER_MAX_PAGES = OUTBOUND_MAX_PAGES;
const FAN_OUT_THRESHOLD = 15;
const MIN_FAN_OUT_SPAN_SECONDS = 25 * 60 * 60;

/**
 * @param {string | null | undefined} funderAddress
 * @param {{ maxPages?: number, callAnkr?: Function, onCoverage?: (coverage: object) => void }} [opts]
 * @returns {Promise<import('../evidence/model.js').EvidenceItem | null>}
 */
export async function analyzeFunderFanOut(funderAddress, opts = {}) {
  if (!funderAddress) {
    opts.onCoverage?.({
      complete: true,
      pagesWalked: { native: 0, token: 0 },
      recipientCount: 0,
      spanSeconds: 0,
      thresholdMet: false,
    });
    return null;
  }

  const observation = opts.observation ?? await observeDirectOutbound(funderAddress, opts);
  const records = deduplicateDirectEdges(observation.records);
  const recipients = new Map();
  for (const record of records) {
    const recipientKey = record.to.toLowerCase();
    if (!recipients.has(recipientKey)) recipients.set(recipientKey, record.to);
  }
  const timestamps = records
    .map((record) => record.timestamp)
    .filter((timestamp) => timestamp !== null);
  const recipientCount = recipients.size;
  const spanSeconds = timestamps.length >= 2
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : 0;
  const thresholdMet = recipientCount >= FAN_OUT_THRESHOLD
    && spanSeconds >= MIN_FAN_OUT_SPAN_SECONDS;
  const complete = observation.complete;
  const incompleteReason = observation.incompleteReason;
  const pagesWalked = observation.pagesWalked;

  opts.onCoverage?.({
    complete,
    pagesWalked,
    recipientCount,
    spanSeconds,
    thresholdMet,
    ...(complete ? {} : { reason: incompleteReason }),
  });
  if (!thresholdMet) return null;

  const txHashes = [...new Set(records.map((record) => record.txHash).filter(Boolean))];
  const blockNumbers = [...new Set(
    records.map((record) => record.blockNumber).filter((value) => value !== undefined)
  )];
  const cutoffRecord = records
    .filter((record) => record.blockNumber !== undefined)
    .reduce((latest, record) => !latest || record.blockNumber > latest.blockNumber ? record : latest, null);

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.FUNDER_FAN_OUT}:${funderAddress.toLowerCase()}:${recipientCount}:${spanSeconds}`,
    signalCode: SIGNAL_CODES.FUNDER_FAN_OUT,
    polarity: 'contextual',
    strength: 'one_hop',
    addresses: [funderAddress, ...recipients.values()],
    ...(txHashes.length > 0 ? { txHashes } : {}),
    ...(blockNumbers.length > 0 ? { blockNumbers } : {}),
    ...(cutoffRecord ? {
      observationCutoff: {
        block: cutoffRecord.blockNumber,
        ...(cutoffRecord.txHash ? { hash: cutoffRecord.txHash } : {}),
      },
    } : {}),
    rpcMethod: 'ankr_getTransactionsByAddress+ankr_getTokenTransfers',
    metrics: {
      recipientCount,
      spanSeconds,
      threshold: FAN_OUT_THRESHOLD,
      minimumSpanSeconds: MIN_FAN_OUT_SPAN_SECONDS,
    },
    derivationMethod: 'distinct direct recipients of bounded native and decoded token payouts from the observed direct funder',
    complete,
    ...(complete ? {} : { incompleteReason }),
    note: 'The direct funder paid at least 15 distinct recipients over at least 25 hours. This is exchange/payment-processor-like context and is never sufficient for HIGH risk on its own.',
  });
}
