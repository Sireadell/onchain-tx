// Signal module registry/boundary. The assessment route should import
// from here, not reach into individual signal files directly, so the
// fast-tier signal set is declared in one place.
//
// FAST TIER (P0, synchronous): direct funder, direct circular funding,
// funder fan-out, funding cluster (including same-funder burst-timing and
// amount-uniformity detail, see clustering.js). Plus known-exchange
// classification (P1 roadmap item 8, exchange subset only — pure
// registry lookup, no RPC cost, so it's fast-tier by construction) and
// known-risk classification (P1 roadmap item 9, OFAC sanctions + known
// scam denylist — also pure registry lookup, no RPC cost). Plus subject
// applicability classification (P0 roadmap item 1, burn/null address +
// known-mixer registry — also pure registry lookup, no RPC cost). All
// bounded to
// docs/LOCKED_SPEC.md's p90 < 15s target, see each module's own page-cap
// notes.
//
// NOT in the fast tier, deep/background only if ever built: second-hop
// funder trace, second-hop fan-out, second-hop circular funding. See
// docs/HANDOFF.md "Known problems" for why (the old project's own
// instrumentation showed these as the dominant cost for the weakest
// evidence tier).

export { findDirectFunder } from './fundingRelationship.js';
export { checkDirectCircularFunding } from './circularFunding.js';
export { analyzeFunderFanOut } from './fanOut.js';
export { recordAndGetFundingCluster } from './clustering.js';
export {
  checkKnownExchangeFunder,
  checkKnownBridgeFunder,
  checkSubjectKnownEntity,
} from './knownEntities.js';
export { checkKnownRiskAddress, checkKnownRiskFunder } from './knownRisk.js';
export { checkSubjectApplicability } from './subjectApplicability.js';
export { checkConvergentRelayFunding } from './convergentRelayFunding.js';
export { checkContractControlRisk } from './contractControlRisk.js';
export { checkLiveSolvencyRisk } from './liveSolvencyRisk.js';
