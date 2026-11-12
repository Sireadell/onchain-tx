// P0 signal: Convergent Relay Funding (roadmap item 2 addendum, see
// docs/LOCKED_SPEC.md).
//
// Detects the pattern:
//   U -> F1 -> wallet
//   U -> F2 -> wallet
// where two of the wallet's own DISTINCT relevant funders (F1, F2) were
// both themselves recently funded by the same upstream address U before
// relaying value into the wallet. This is the harder Sybil-evasion case
// FUNDING_CLUSTER can't catch: an operator using a different disposable
// funder for every target wallet still has to fund each of those
// disposable funders from somewhere, and this signal looks for that
// somewhere being the same address.
//
// Deliberately reuses findDirectFunder() one hop up rather than writing
// new pagination/candidate logic: calling it on F1 and F2 (instead of on
// the wallet) answers exactly "who funded this address" for each of
// them, which is the same question, one level up the chain. Capped to
// maxPages: 1 per funder (native + token in parallel, so 2 page-fetches
// each) -- shallower than findDirectFunder's own default of 3, since this
// runs on top of an already-expensive fast-tier path (see
// docs/LOCKED_SPEC.md p90 budget notes) and only needs to catch a
// *recent* common funder, not an exhaustive history.
//
// Contextual only, like FUNDER_FAN_OUT and FUNDING_CLUSTER: a shared
// upstream funder proves a funding relationship existed, not common
// ownership, coordination, or fraud. Scoring (e.g. an ELEVATED tier for
// ordered, amount-consistent relays) is a separate, benchmark-gated pass
// -- see docs/LOCKED_SPEC.md roadmap item 2 addendum. Do not wire this
// into risk_score without that calibration.

import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import { classifyKnownEntity } from './knownEntities.js';
import { findDirectFunder } from './fundingRelationship.js';

const RELAY_MAX_PAGES = 1;

// Same tolerance convention as clustering.js's amount-uniformity check
// (2%), reused here rather than invented fresh, so "amount-consistent"
// means the same thing across both signals.
const AMOUNT_TOLERANCE_BPS = 200n;

function amountsConsistent(rawA, rawB) {
  if (rawA === undefined || rawB === undefined) return false;
  let a; let b;
  try {
    a = BigInt(rawA);
    b = BigInt(rawB);
  } catch {
    return false;
  }
  if (a <= 0n || b <= 0n) return false;
  const low = a < b ? a : b;
  const high = a < b ? b : a;
  const spreadBps = ((high - low) * 10000n) / low;
  return spreadBps <= AMOUNT_TOLERANCE_BPS;
}

// Finds the edge (relationship entry) in a funder's own findDirectFunder
// evidence that corresponds to upstream address `u` -- either its
// earliest funder (asset.from) or one of its other relevant funders
// (relationships list).
function edgeFromUpstream(funderEvidence, u) {
  const key = u.toLowerCase();
  if (funderEvidence.asset?.from?.toLowerCase() === key) {
    return {
      funder: funderEvidence.asset.from,
      txHash: funderEvidence.txHashes?.[0],
      blockNumber: funderEvidence.blockNumbers?.[0],
      timestamp: funderEvidence.asset.timestamp,
      valueRaw: funderEvidence.asset.valueRaw,
    };
  }
  const relationship = funderEvidence.relationships?.find(
    (rel) => rel.funder?.toLowerCase() === key
  );
  if (!relationship) return null;
  return {
    funder: relationship.funder,
    txHash: relationship.txHash,
    blockNumber: relationship.blockNumber,
    timestamp: relationship.timestamp,
    valueRaw: relationship.valueRaw,
  };
}

// Finds the wallet-level edge (F -> wallet) from the relationships list
// already produced by findDirectFunder(wallet), so this signal doesn't
// need to re-fetch information the caller already has.
function walletEdgeForFunder(walletFunderRelationships, funder) {
  const key = funder.toLowerCase();
  return (walletFunderRelationships ?? []).find(
    (rel) => rel.funder?.toLowerCase() === key
  ) ?? null;
}

/**
 * @param {string} wallet
 * @param {string[]} relevantFunders - the wallet's own relevantFunders,
 *   as produced by findDirectFunder(wallet) (already bounded to 2).
 * @param {Array<Object>} walletFunderRelationships - the `relationships`
 *   array from findDirectFunder(wallet)'s evidence item, used to recover
 *   each funder's own edge into the wallet without a re-fetch.
 * @param {{ callAnkr?: Function, onCoverage?: (coverage: object) => void }} [opts]
 * @returns {Promise<import('../evidence/model.js').EvidenceItem | null>}
 */
export async function checkConvergentRelayFunding(wallet, relevantFunders, walletFunderRelationships, opts = {}) {
  const distinctFunders = [...new Set((relevantFunders ?? []).map((f) => f.toLowerCase()))]
    .map((lower) => relevantFunders.find((f) => f.toLowerCase() === lower));

  if (distinctFunders.length < 2) {
    // Not a data gap -- most wallets simply only have one relevant
    // funder, which is a completely normal, fully-assessed case. This
    // must stay `complete: true` (never 'skipped'/'partial') so a
    // single-funder wallet doesn't get downgraded to LIMITED just
    // because an optional two-funder comparison had nothing to compare.
    opts.onCoverage?.({ complete: true, reason: 'fewer_than_two_relevant_funders' });
    return null;
  }

  const [f1, f2] = distinctFunders;

  const [funder1Evidence, funder2Evidence] = await Promise.all([
    findDirectFunder(f1, { ...opts, maxPages: RELAY_MAX_PAGES }),
    findDirectFunder(f2, { ...opts, maxPages: RELAY_MAX_PAGES }),
  ]);

  const complete = (funder1Evidence?.complete ?? true) && (funder2Evidence?.complete ?? true);
  const upstream1 = funder1Evidence?.relevantFunders ?? [];
  const upstream2 = funder2Evidence?.relevantFunders ?? [];

  const commonUpstream = upstream1.find(
    (u1) => upstream2.some((u2) => u2.toLowerCase() === u1.toLowerCase())
  );

  opts.onCoverage?.({
    complete,
    checkedFunders: [f1, f2],
    commonUpstreamFound: Boolean(commonUpstream),
    ...(complete ? {} : { reason: 'page_cap_reached' }),
  });

  if (!commonUpstream) return null;

  // Exclude/downgrade normal shared funding sources: many unrelated
  // wallets legitimately share an exchange or bridge as their upstream
  // funder, so that alone isn't the pattern this signal is for.
  const upstreamClassification = classifyKnownEntity(commonUpstream, opts.chain);
  if (upstreamClassification) return null;

  const edgeU1 = edgeFromUpstream(funder1Evidence, commonUpstream);
  const edgeU2 = edgeFromUpstream(funder2Evidence, commonUpstream);
  const edgeF1Wallet = walletEdgeForFunder(walletFunderRelationships, f1);
  const edgeF2Wallet = walletEdgeForFunder(walletFunderRelationships, f2);

  // All four edges (U->F1, U->F2, F1->wallet, F2->wallet) must have
  // resolvable provenance for this to be reportable at all -- an
  // incomplete edge means this can never be scored as HIGH later
  // (see LOCKED_SPEC roadmap item 2 addendum), but it's also not safe to
  // present as a complete CRF finding if any edge's evidence is missing.
  const edges = [edgeU1, edgeU2, edgeF1Wallet, edgeF2Wallet];
  const provenanceComplete = edges.every((edge) => edge?.txHash && edge?.blockNumber !== undefined);

  const relayLatencySeconds1 = edgeU1?.timestamp != null && edgeF1Wallet?.timestamp != null
    ? edgeF1Wallet.timestamp - edgeU1.timestamp
    : null;
  const relayLatencySeconds2 = edgeU2?.timestamp != null && edgeF2Wallet?.timestamp != null
    ? edgeF2Wallet.timestamp - edgeU2.timestamp
    : null;
  const upstreamFundingGapSeconds = edgeU1?.timestamp != null && edgeU2?.timestamp != null
    ? Math.abs(edgeU1.timestamp - edgeU2.timestamp)
    : null;
  const amountConsistent = amountsConsistent(edgeU1?.valueRaw, edgeU2?.valueRaw);
  // "Ordered": U funded both F1 and F2 before each relayed into the
  // wallet -- i.e. the relay didn't happen before the upstream funding
  // (which would mean the addresses aren't actually part of one chain).
  const orderedRelay = relayLatencySeconds1 !== null && relayLatencySeconds1 >= 0
    && relayLatencySeconds2 !== null && relayLatencySeconds2 >= 0;

  const txHashes = [...new Set(edges.map((e) => e?.txHash).filter(Boolean))];
  const blockNumbers = [...new Set(edges.map((e) => e?.blockNumber).filter((v) => v !== undefined))];

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.CONVERGENT_RELAY_FUNDING}:${wallet.toLowerCase()}:${commonUpstream.toLowerCase()}`,
    signalCode: SIGNAL_CODES.CONVERGENT_RELAY_FUNDING,
    polarity: 'contextual',
    strength: 'two_hop',
    addresses: [wallet, f1, f2, commonUpstream],
    ...(txHashes.length ? { txHashes } : {}),
    ...(blockNumbers.length ? { blockNumbers } : {}),
    rpcMethod: 'ankr_getTransactionsByAddress+ankr_getTokenTransfers',
    metrics: {
      provenanceComplete,
      orderedRelay,
      amountConsistent,
      amountToleranceBps: Number(AMOUNT_TOLERANCE_BPS),
      ...(relayLatencySeconds1 !== null ? { relayLatencySeconds1 } : {}),
      ...(relayLatencySeconds2 !== null ? { relayLatencySeconds2 } : {}),
      ...(upstreamFundingGapSeconds !== null ? { upstreamFundingGapSeconds } : {}),
    },
    relationships: [
      { edge: 'upstream_to_funder1', funder: commonUpstream, recipient: f1, ...edgeU1 },
      { edge: 'upstream_to_funder2', funder: commonUpstream, recipient: f2, ...edgeU2 },
      { edge: 'funder1_to_wallet', funder: f1, recipient: wallet, ...edgeF1Wallet },
      { edge: 'funder2_to_wallet', funder: f2, recipient: wallet, ...edgeF2Wallet },
    ],
    derivationMethod: 'two distinct relevant funders of the assessed wallet were both themselves recently funded by the same upstream address, checked via one bounded hop up the funding chain from each funder',
    complete: complete && provenanceComplete,
    ...(complete && provenanceComplete ? {} : { incompleteReason: !complete ? 'page_cap_reached' : 'partial_edge_provenance' }),
    note: `Both ${f1} and ${f2}, which independently fund ${wallet}, were themselves recently funded by the same upstream address (${commonUpstream}).`
      + (orderedRelay ? ' Each relay occurred after that upstream funding, consistent with a deliberate funding chain.' : '')
      + (amountConsistent ? ' The two upstream transfers were also similar in amount.' : '')
      + ' This proves the funding relationships, not common ownership, coordination, or fraud, and is contextual only.',
  });
}
