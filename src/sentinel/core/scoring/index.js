// Deterministic scoring module boundary.
//
// This initial implementation scores the bounded direct-funder,
// direct-circular-funding, and funder fan-out path. Do not port the old project's decideVerdict()
// all-or-nothing gate (src/lib/scoring.js in telegraph-forensics-miner),
// that structure is *why* the old miner almost never returned a confident
// PASS: any single incomplete signal anywhere forced PARTIAL. Sentinel's
// scoring should degrade `confidence` and/or `assessmentStatus`
// gracefully instead of collapsing the whole verdict on any one gap.
//
// Broader weighting belongs in the later signal implementation pass. For
// now, only hash-backed direct circular funding raises relationship risk;
// coverage independently controls confidence and assessment status.

import { CIRCUMSTANTIAL_ONLY_CODES, DIRECT_DENYLIST_CODES, SIGNAL_CODES } from '../evidence/model.js';
import { makeAssessment } from '../assessment/model.js';

/**
 * Hard constraint check: circumstantial-only evidence (fan-out, funding
 * clusters including same-funder burst-timing/amount-uniformity detail)
 * must never be the sole basis for a HIGH risk_level. Call this as an
 * assertion inside computeAssessment once it's implemented, not just as
 * documentation.
 *
 * @param {import('../evidence/model.js').EvidenceItem[]} evidence
 * @param {import('../assessment/model.js').RiskLevel} riskLevel
 */
export function assertFanOutNotSoleBasisForHigh(evidence, riskLevel) {
  if (riskLevel !== 'HIGH') return;
  const riskEvidence = evidence.filter((e) => e.polarity === 'risk');
  const nonCircumstantial = riskEvidence.filter(
    (e) => !CIRCUMSTANTIAL_ONLY_CODES.includes(e.signalCode)
  );
  const circumstantial = evidence.filter((e) =>
    CIRCUMSTANTIAL_ONLY_CODES.includes(e.signalCode)
  );
  if (circumstantial.length > 0 && nonCircumstantial.length === 0) {
    throw new Error(
      'Scoring violation: HIGH risk_level derived solely from circumstantial-only evidence. ' +
        'See docs/LOCKED_SPEC.md hard constraint.'
    );
  }
}

/**
 * @param {string} wallet
 * @param {import('../evidence/model.js').EvidenceItem[]} evidence
 * @param {Object.<string, { status: string, reason?: string }>} coverage
 * @param {{ latencyMs?: number }} [opts]
 * @returns {import('../assessment/model.js').Assessment}
 */
export function computeAssessment(wallet, evidence, coverage, opts = {}) {
  const circular = evidence.find(
    (item) => item.signalCode === SIGNAL_CODES.DIRECT_CIRCULAR_FUNDING
      && item.polarity === 'risk'
      && item.complete === true
      && Array.isArray(item.txHashes)
      && item.txHashes.length > 0
      && Array.isArray(item.blockNumbers)
      && item.blockNumbers.length > 0
  );
  const fanOut = evidence.find((item) => item.signalCode === SIGNAL_CODES.FUNDER_FAN_OUT);
  const cluster = evidence.find((item) => item.signalCode === SIGNAL_CODES.FUNDING_CLUSTER);
  const convergentRelay = evidence.find(
    (item) => item.signalCode === SIGNAL_CODES.CONVERGENT_RELAY_FUNDING
  );
  const contractControlRisk = evidence.find(
    (item) => item.signalCode === SIGNAL_CODES.CONTRACT_CONTROL_RISK
  );
  const liveSolvencyRisk = evidence.find(
    (item) => item.signalCode === SIGNAL_CODES.LIVE_SOLVENCY_RISK
  );
  const knownExchange = evidence.find(
    (item) => item.signalCode === SIGNAL_CODES.KNOWN_EXCHANGE_FUNDER
  );
  const knownBridge = evidence.find(
    (item) => item.signalCode === SIGNAL_CODES.KNOWN_BRIDGE_FUNDER
  );
  const knownRiskFunders = evidence.filter(
    (item) => item.signalCode === SIGNAL_CODES.SANCTIONED_FUNDER
      || item.signalCode === SIGNAL_CODES.KNOWN_SCAM_FUNDER
  );
  const denylistHits = evidence.filter(
    (item) => item.polarity === 'risk' && DIRECT_DENYLIST_CODES.includes(item.signalCode)
  );
  const sanctioned = denylistHits.find(
    (item) => item.signalCode === SIGNAL_CODES.SANCTIONED_ADDRESS
  );
  const statuses = Object.values(coverage).map((item) => item?.status);
  const hasPartial = statuses.includes('partial');
  const hasSkipped = statuses.includes('skipped');
  const hasMissingMajorBaseCoverage = Object.values(coverage).some(
    (item) => item?.status === 'skipped'
      && (item.reason === 'ethereum_registry_not_applied_to_base'
        || item.reason === 'unsupported_on_base')
  );
  const highTier = Boolean(circular) || denylistHits.length > 0;

  // ELEVATED tier (see docs/LOCKED_SPEC.md "Public risk output"): a calibrated
  // middle ground so circumstantial-only evidence can be represented
  // honestly instead of forcing every non-HIGH wallet into a flat LOW.
  // Provisional thresholds, not final -- see LOCKED_SPEC's own note that
  // exact weights are pending a larger, reviewed benchmark than the
  // current 6-case set.
  // None of these three triggers may promote to HIGH on their own: they
  // only ever set ELEVATED, and this whole block is skipped entirely
  // once highTier is already true (see riskLevel below), so there's no
  // path from circumstantial evidence to HIGH.
  //
  // 1. Coordinated relay: Convergent Relay Funding found a common
  //    upstream funder AND the relay was ordered (funded before it paid
  //    out) AND the two upstream amounts were consistent AND every edge
  //    has full provenance. Per LOCKED_SPEC roadmap item 2a, even a
  //    "complete" CRF finding like this is capped at ELEVATED until the
  //    benchmark validates it -- never HIGH from this alone.
  const coordinatedRelay = Boolean(
    convergentRelay?.metrics?.orderedRelay
      && convergentRelay?.metrics?.amountConsistent
      && convergentRelay?.metrics?.provenanceComplete
  );
  // 2 & 3, NOT YET ENABLED: "suspicious behavioral burst" (funder payouts
  // clustered in a short window) and "multiple co-occurring circumstantial
  // signals" were both live-tested against this project's own ground-truth
  // benchmark (2026-08-20) and produced ELEVATED on Binance 14 and
  // vitalik.eth -- two of the benchmark's LOW/legitimate cases. Root
  // cause: a real high-volume service wallet (payroll, batch payout, an
  // exchange not yet in the known-exchange registry) produces exactly the
  // rapid, uniform-amount, many-recipient pattern these triggers look
  // for, and nothing here currently distinguishes that from a suspicious
  // burst. Needs a volume-aware guard (e.g. skip when recipient count
  // looks exchange-scale) before enabling -- computed and still exposed
  // in evidence metrics (cluster.metrics.burstDetected etc) for whoever
  // builds that guard, just not wired into risk_level yet.
  // Contract controls remain visible as context. Ownership, pause,
  // upgrade, and mint capabilities are common in legitimate contracts,
  // so capability presence alone does not raise fraud risk.
  // Live solvency stays visible as financial context but does not raise
  // fraud risk. Debt distress answers whether a wallet can cover a loan,
  // not whether its operator is fraudulent. Keeping these axes separate
  // avoids a false-positive path in FRAUD_DETECTION.
  const elevatedTier = !highTier && coordinatedRelay;

  // A direct denylist hit is a match against an external source, not an
  // on-chain-behavior inference, so it drives risk independently of
  // whether circular funding was also found. A sanctions hit (official
  // source) scores at least as high as circular funding; a scam-list hit
  // (community-maintained, lower certainty) scores slightly under it.
  const denylistScore = sanctioned ? 0.95 : denylistHits.length > 0 ? 0.85 : 0;
  const riskScore = highTier
    ? Math.max(circular ? 0.9 : 0, denylistScore) || 0.1
    : elevatedTier
      ? 0.5
      : 0.1;
  const riskLevel = highTier ? 'HIGH' : elevatedTier ? 'ELEVATED' : 'LOW';
  let assessmentStatus = 'ASSESSED';
  let confidence = highTier ? 0.95 : elevatedTier ? 0.75 : 0.8;

  // Missing an entire major signal family is more limiting than a
  // partial bounded scan. If both occur, INCONCLUSIVE must win so Base
  // cannot look more complete merely because history was also partial.
  if (hasMissingMajorBaseCoverage) {
    assessmentStatus = 'INCONCLUSIVE';
    confidence = highTier ? 0.65 : elevatedTier ? 0.4 : 0.25;
  } else if (hasPartial) {
    assessmentStatus = 'LIMITED';
    confidence = highTier ? 0.7 : elevatedTier ? 0.5 : 0.35;
  } else if (hasSkipped) {
    assessmentStatus = 'INCONCLUSIVE';
    confidence = highTier ? 0.65 : elevatedTier ? 0.4 : 0.25;
  }

  const reasonCodes = [...new Set(evidence.map((item) => item.signalCode))];
  if (hasPartial) reasonCodes.push('OBSERVATION_INCOMPLETE');
  if (hasSkipped) reasonCodes.push('SIGNAL_SKIPPED');

  const fanOutContext = fanOut
    ? ' The direct funder also shows broad payout behavior consistent with an exchange, payment processor, treasury, or other service wallet; that context is circumstantial and does not independently raise risk.'
    : '';
  const clusterContext = cluster
    ? ' Sentinel also observed multiple distinct wallets receiving direct transfers from the same funder. This proves the transfer relationships, not common ownership, coordination, Sybil behavior, or fraud, and it does not independently raise risk.'
    : '';
  const convergentRelayContext = convergentRelay ? ` ${convergentRelay.note}` : '';
  const contractControlRiskContext = contractControlRisk ? ` ${contractControlRisk.note}` : '';
  const liveSolvencyRiskContext = liveSolvencyRisk ? ` ${liveSolvencyRisk.note}` : '';
  const knownExchangeContext = knownExchange
    ? ' The direct funder address matches a known centralized-exchange wallet, which is a normal, common funding source and explains any fan-out/cluster behavior observed above; it does not independently lower or raise risk.'
    : '';
  const knownBridgeContext = knownBridge
    ? ' The direct funder address matches a known cross-chain bridge contract, which is a normal, common funding source and explains any fan-out/cluster behavior observed above; it does not independently lower or raise risk.'
    : '';
  const knownRiskFunderContext = knownRiskFunders.length > 0
    ? ` ${knownRiskFunders.map((item) => item.note).join(' ')}`
    : '';
  const denylistContext = denylistHits.length > 0
    ? ` ${denylistHits.map((item) => item.note).join(' ')}`
    : '';
  const elevatedReasonParts = [];
  if (coordinatedRelay) {
    elevatedReasonParts.push('two of its funders were both recently funded by the same upstream address, in an ordered, amount-consistent relay');
  }
  const elevatedReasons = elevatedReasonParts.join('; and ');
  const contextSuffix = `${fanOutContext}${clusterContext}${convergentRelayContext}${contractControlRiskContext}${liveSolvencyRiskContext}${knownExchangeContext}${knownBridgeContext}${knownRiskFunderContext}`;
  const explanation = denylistHits.length > 0
    ? `High risk: ${denylistContext.trim()}${circular ? ' In addition, an observed transaction shows the wallet sent funds directly to its identified funder, consistent with circular funding.' : ''}${contextSuffix}`
    : circular
      ? `High relationship risk: an observed transaction shows the wallet sent funds directly to its identified funder. This is evidence of circular funding, not a definitive finding of fraud.${contextSuffix}`
      : elevatedTier
        ? `Elevated relationship risk: ${elevatedReasons}. This is circumstantial, not a definitive finding of fraud, and is not sufficient on its own for a HIGH verdict.${contextSuffix}`
        : assessmentStatus === 'ASSESSED'
          ? `Low observed relationship risk in the bounded scan: no direct circular transfer to the identified funder was found. LOW does not mean the wallet is guaranteed safe.${contextSuffix}`
          : `The bounded observation did not support a strong relationship-risk conclusion. Missing or incomplete history is not evidence of safety.${contextSuffix}`;

  // Short, single-sentence lead verdict, distinct from the detailed
  // `explanation` above. Inspired by a competing miner's terser response
  // style (ChainSight) -- kept as an addition alongside the existing
  // detailed explanation, not a replacement for it, since Sentinel's
  // evidence-backed detail is the actual product differentiator; this
  // just gives a reader (human or evaluator) the headline first.
  const summary = denylistHits.length > 0
    ? `HIGH risk: direct match on a sanctions or known-scam list.`
    : circular
      ? `HIGH risk: wallet sent funds directly back to its own funder (circular funding).`
      : elevatedTier
        ? `ELEVATED risk: ${elevatedReasons}.`
        : assessmentStatus === 'ASSESSED'
          ? `LOW risk: no risk-bearing evidence found in the bounded scan.`
          : `INCONCLUSIVE: not enough evidence gathered to reach a confident verdict.`;

  assertFanOutNotSoleBasisForHigh(evidence, riskLevel);
  return makeAssessment({
    wallet,
    risk_score: riskScore,
    risk_level: riskLevel,
    confidence,
    assessment_status: assessmentStatus,
    reason_codes: reasonCodes,
    explanation,
    summary,
    evidence,
    coverage,
    latency_ms: opts.latencyMs ?? 0,
  });
}
