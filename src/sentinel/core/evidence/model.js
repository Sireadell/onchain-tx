// Evidence data model, see docs/LOCKED_SPEC.md "Evidence model" section
// for the full field rationale. This module is the single place that
// defines the shape; signal modules should build items via
// makeEvidenceItem() rather than hand-rolling object literals, so the
// shape can't silently drift per-signal.

/** @typedef {'risk' | 'exculpatory' | 'contextual'} EvidencePolarity */
/** @typedef {'direct' | 'one_hop' | 'two_hop' | 'registry_derived'} EvidenceStrength */

/**
 * @typedef {Object} EvidenceItem
 * @property {string} evidenceId - stable id, e.g. `${signalCode}:${wallet}:${counterparty}`
 * @property {string} signalCode - stable reason code, e.g. 'DIRECT_CIRCULAR_FUNDING'
 * @property {EvidencePolarity} polarity
 * @property {EvidenceStrength} strength
 * @property {number} [chainId]
 * @property {string[]} addresses
 * @property {string[]} [txHashes]
 * @property {number[]} [blockNumbers]
 * @property {{ block?: number, hash?: string }} [observationCutoff]
 * @property {string} retrievedAt - ISO timestamp
 * @property {string} [rpcMethod]
 * @property {{ symbol?: string, valueRaw?: string, from?: string, to?: string, timestamp?: number }} [asset]
 * @property {Object.<string, number | string | boolean>} [metrics] - bounded aggregate values used by the derivation
 * @property {Array<Object>} [relationships] - direct relationship edges with per-edge provenance
 * @property {string} derivationMethod - short description of how this was computed
 * @property {string} [entityClassification] - e.g. 'known_exchange', 'bridge', 'contract'
 * @property {{ name?: string, version?: string, asOf?: string }} [source] - for registry-derived evidence
 * @property {boolean} complete - was the underlying scan exhaustive, or bounded/cut off
 * @property {string} [incompleteReason]
 * @property {string} [note] - human-readable, independently reverifiable framing
 */

let counter = 0;

/**
 * @param {Partial<EvidenceItem> & Pick<EvidenceItem, 'signalCode' | 'polarity' | 'strength' | 'addresses' | 'derivationMethod' | 'complete'>} fields
 * @returns {EvidenceItem}
 */
export function makeEvidenceItem(fields) {
  counter += 1;
  return {
    evidenceId: fields.evidenceId ?? `${fields.signalCode}:${counter}`,
    retrievedAt: fields.retrievedAt ?? new Date().toISOString(),
    ...fields,
  };
}

// Signal codes: stable strings referenced by scoring and by
// docs/EVALUATOR_NOTES.md reason_codes. Add new codes here, don't invent
// ad hoc strings at call sites.
export const SIGNAL_CODES = Object.freeze({
  DIRECT_FUNDER: 'DIRECT_FUNDER',
  DIRECT_CIRCULAR_FUNDING: 'DIRECT_CIRCULAR_FUNDING',
  FUNDER_FAN_OUT: 'FUNDER_FAN_OUT',
  FUNDING_CLUSTER: 'FUNDING_CLUSTER',
  KNOWN_EXCHANGE_FUNDER: 'KNOWN_EXCHANGE_FUNDER',
  KNOWN_BRIDGE_FUNDER: 'KNOWN_BRIDGE_FUNDER',
  WALLET_AGE_ACTIVITY: 'WALLET_AGE_ACTIVITY', // insufficient-alone, see LOCKED_SPEC
  SANCTIONED_ADDRESS: 'SANCTIONED_ADDRESS', // roadmap item 9, see knownRisk.js
  KNOWN_SCAM_ADDRESS: 'KNOWN_SCAM_ADDRESS', // roadmap item 9, see knownRisk.js
  SANCTIONED_FUNDER: 'SANCTIONED_FUNDER', // contextual counterparty match, see knownRisk.js
  KNOWN_SCAM_FUNDER: 'KNOWN_SCAM_FUNDER', // contextual counterparty match, see knownRisk.js
  SUBJECT_NOT_STANDARD_WALLET: 'SUBJECT_NOT_STANDARD_WALLET', // roadmap item 1, see subjectApplicability.js
  // The assessed address is ITSELF a publicly identified exchange or
  // bridge address, not merely funded by one. Added 2026-08-28: the
  // exchange/bridge registries were only ever consulted against a
  // funder, so a question about e.g. Binance 14 (already in our own
  // list) came back "LIMITED, confidence 0.35, not enough evidence"
  // instead of naming what the address plainly is. See knownEntities.js.
  SUBJECT_KNOWN_EXCHANGE: 'SUBJECT_KNOWN_EXCHANGE',
  SUBJECT_KNOWN_BRIDGE: 'SUBJECT_KNOWN_BRIDGE',
  CONVERGENT_RELAY_FUNDING: 'CONVERGENT_RELAY_FUNDING', // roadmap item 2 addendum, see convergentRelayFunding.js
  CONTRACT_CONTROL_RISK: 'CONTRACT_CONTROL_RISK', // contract-level risk check, see contractControlRisk.js
  LIVE_SOLVENCY_RISK: 'LIVE_SOLVENCY_RISK', // live solvency check, see liveSolvencyRisk.js
});

// Signal codes backed by a direct hit against an authoritative or
// actively-maintained external denylist (not an on-chain-behavior
// inference). Deliberately NOT listed in CIRCUMSTANTIAL_ONLY_CODES below:
// a match here is sufficient on its own to justify HIGH risk_level, same
// tier as direct circular funding. See knownRisk.js.
export const DIRECT_DENYLIST_CODES = Object.freeze([
  SIGNAL_CODES.SANCTIONED_ADDRESS,
  SIGNAL_CODES.KNOWN_SCAM_ADDRESS,
]);

// Strength tiers that must NEVER independently drive HIGH risk, see
// docs/LOCKED_SPEC.md "Hard constraint". Scoring module should assert
// against this, not just informally respect it.
export const CIRCUMSTANTIAL_ONLY_CODES = Object.freeze([
  SIGNAL_CODES.FUNDER_FAN_OUT,
  SIGNAL_CODES.FUNDING_CLUSTER,
  SIGNAL_CODES.SANCTIONED_FUNDER,
  SIGNAL_CODES.KNOWN_SCAM_FUNDER,
  // Not yet risk-bearing at all (polarity: 'contextual', see
  // convergentRelayFunding.js) -- listed here ahead of time so that if a
  // future ELEVATED-tier scoring pass ever promotes it to polarity:
  // 'risk', it can never alone justify HIGH without this guard already
  // in place. See docs/LOCKED_SPEC.md roadmap item 2 addendum.
  SIGNAL_CODES.CONVERGENT_RELAY_FUNDING,
  // Also listed defensively: the mint-selector-present factor is a
  // bytecode heuristic (function exists) not proof it's unrestricted or
  // reachable, so contract-control-risk evidence is capped at ELEVATED
  // in scoring/index.js, same as convergent relay funding above, pending
  // benchmark validation. See contractControlRisk.js.
  SIGNAL_CODES.CONTRACT_CONTROL_RISK,
  // Also listed defensively, though this one is stronger evidence than
  // the others here: live solvency risk is direct, current protocol
  // state (Aave's own getUserAccountData()), not a behavioral inference
  // or bytecode heuristic. Still capped at ELEVATED for now, purely for
  // consistency with this project's established "new signal ships
  // conservative until benchmark-validated" discipline -- a case could
  // be made for letting "already eligible for liquidation right now"
  // independently justify HIGH, but that's a deliberate choice to
  // revisit with real benchmark data, not decided here. See
  // liveSolvencyRisk.js.
  SIGNAL_CODES.LIVE_SOLVENCY_RISK,
]);

export const INSUFFICIENT_ALONE_CODES = Object.freeze([
  SIGNAL_CODES.FUNDING_CLUSTER,
  SIGNAL_CODES.WALLET_AGE_ACTIVITY,
]);
