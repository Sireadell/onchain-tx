// P0 signal: subject-address applicability classification (roadmap item 1).
//
// Runs before any funding-relationship analysis, against the assessed
// wallet itself (not a funder). Pure static registry lookups -- no RPC
// call, no latency cost, always complete.
//
// Generic EOA-vs-contract detection (eth_getCode or equivalent) was
// evaluated and is NOT available on the current Ankr Advanced API plan:
// confirmed live 2026-08-20 -- both the multichain endpoint and the
// per-chain eth endpoint reject `eth_getCode` (multichain: "method does
// not exist/is not available"; per-chain eth endpoint: "API key is not
// allowed to access blockchain"). No ankr_-prefixed contract-metadata
// method exists as a substitute either (ankr_getContractMetadata,
// ankr_getNftMetadata both come back method-not-available). So this
// module can only catch the specific cases below (burn/null addresses,
// and contracts on the known-mixer registry), not "any contract" in
// general. A subject that's some other, unlisted contract will still
// fall through to normal wallet scoring -- a known, logged gap, not a
// silently dropped one. Revisit if a provider/plan supporting contract
// bytecode lookups is added.
//
// Why this matters: without this check, a burn address or a pooling
// contract like Tornado Cash's router gets scored as risk_level: LOW,
// which reads as "we checked, it's clean" -- false confidence, since
// funding-relationship analysis structurally doesn't apply to either
// (see benchmark/ground-truth-results.json's "Null/burn address" and
// "Tornado Cash router contract" cases, both currently mis-scored LOW).

import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';

// Universal Ethereum burn-address convention. These aren't a
// third-party-sourced registry the way exchange/bridge/mixer addresses
// are -- the zero address is defined by the protocol itself (no private
// key, precompile-adjacent), and 0x000...dEaD is a community convention
// so widely adopted it needs no external label to confirm.
const BURN_NULL_ADDRESSES = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
];

const burnNullSet = new Set(BURN_NULL_ADDRESSES);

// Known pooling/mixer contracts. Each entry confirmed against a live
// Etherscan label before inclusion, same provenance bar as
// knownEntities.js's exchange/bridge lists. Deliberately small and
// specific (not a generic "any contract" list) -- see module comment
// above for why a broader check isn't currently possible.
const KNOWN_MIXER_ADDRESSES = [
  // Confirmed 2026-08-20 against Etherscan public name tag "Tornado.Cash: Router"
  '0x722122df12d4e14e13ac3b6895a86e84145b6967',
];

const knownMixerSet = new Set(KNOWN_MIXER_ADDRESSES);

/**
 * @param {string | null | undefined} address
 * @returns {{ type: 'burn_null' | 'known_mixer' } | null}
 */
export function classifySubjectApplicability(address, chain = 'eth') {
  if (!address) return null;
  const normalized = address.toLowerCase();
  if (burnNullSet.has(normalized)) return { type: 'burn_null' };
  if (chain === 'eth' && knownMixerSet.has(normalized)) return { type: 'known_mixer' };
  return null;
}

/**
 * Checks whether the assessed wallet itself is a standard, fundable EOA
 * that funding-relationship analysis actually applies to. Returns null
 * for an ordinary address (the common case -- proceed with normal
 * scoring); returns evidence when the subject should be short-circuited
 * to a NOT_APPLICABLE assessment instead.
 *
 * @param {string | null | undefined} wallet
 * @returns {import('../evidence/model.js').EvidenceItem | null}
 */
export function checkSubjectApplicability(wallet, opts = {}) {
  const classification = classifySubjectApplicability(wallet, opts.chain);
  if (!classification) return null;

  const note = classification.type === 'burn_null'
    ? 'This address is a standard Ethereum burn/null address, not a wallet with a private key. Funding-relationship risk analysis does not apply: there is no owner who could be receiving or laundering funds through it.'
    : 'This address matches a known pooling/mixer contract, not a normal externally-owned wallet. Funder and circular-funding signals do not behave meaningfully against a pooling contract, so a standard wallet-risk verdict would be misleading either way.';

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.SUBJECT_NOT_STANDARD_WALLET}:${wallet.toLowerCase()}`,
    signalCode: SIGNAL_CODES.SUBJECT_NOT_STANDARD_WALLET,
    polarity: 'contextual',
    strength: 'registry_derived',
    addresses: [wallet],
    entityClassification: classification.type,
    source: { name: 'sentinel_subject_applicability_registry', asOf: '2026-08-20' },
    derivationMethod: 'static_address_registry_lookup',
    complete: true,
    note,
  });
}
