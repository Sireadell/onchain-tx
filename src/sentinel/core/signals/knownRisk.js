// P1 signal: known-risk classification (LOCKED_SPEC roadmap item 9,
// "Known-risk context, only where a reliable source actually exists").
//
// Pure registry lookup, no RPC call: checks the assessed wallet itself,
// and any direct funder, against two external denylists:
//   - OFAC-sanctioned addresses (src/data/ofacSanctionedAddresses.json,
//     built from the official US Treasury SDN sanctions data)
//   - Known scam/phishing addresses (src/data/scamsnifferAddresses.json,
//     community-maintained, see source field in that file)
//
// Unlike knownEntities.js's exchange check, a match here IS risk-bearing:
// this is a direct hit against an authoritative or actively-maintained
// external source, not an inference from on-chain behavior. It is
// deliberately NOT added to CIRCUMSTANTIAL_ONLY_CODES in
// evidence/model.js — an OFAC match on its own is sufficient basis for
// HIGH risk, same tier as direct circular funding.
//
// Re-fetch these lists periodically; each carries its own source/asOf
// metadata rather than being silently treated as always current.

import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import ofacList from '../../data/ofacSanctionedAddresses.json' with { type: 'json' };
import scamList from '../../data/scamsnifferAddresses.json' with { type: 'json' };

const ofacSet = new Set(ofacList.addresses.map((a) => a.toLowerCase()));
const scamSet = new Set(scamList.addresses.map((a) => a.toLowerCase()));

/**
 * @param {string | null | undefined} address
 * @returns {{ type: 'sanctioned' | 'known_scam' } | null}
 */
export function classifyKnownRisk(address) {
  if (!address) return null;
  const normalized = address.toLowerCase();
  if (ofacSet.has(normalized)) return { type: 'sanctioned' };
  if (scamSet.has(normalized)) return { type: 'known_scam' };
  return null;
}

/**
 * Checks a single address (the assessed wallet, or a funder) against the
 * known-risk registries.
 *
 * @param {string | null | undefined} address
 * @returns {import('../evidence/model.js').EvidenceItem | null}
 */
export function checkKnownRiskAddress(address, opts = {}) {
  if ((opts.chain ?? 'eth') !== 'eth') return null;
  const classification = classifyKnownRisk(address);
  if (!classification) return null;

  const isSanctioned = classification.type === 'sanctioned';
  const signalCode = isSanctioned
    ? SIGNAL_CODES.SANCTIONED_ADDRESS
    : SIGNAL_CODES.KNOWN_SCAM_ADDRESS;
  const source = isSanctioned
    ? { name: 'ofac_sdn_digital_currency_addresses', asOf: ofacList.fetchedAt }
    : { name: 'scamsniffer_scam_database', asOf: scamList.fetchedAt };
  const note = isSanctioned
    ? 'This address matches the OFAC Specially Designated Nationals (SDN) sanctions list of digital currency addresses. This is a direct match against an official US Treasury source, not an inference from on-chain behavior.'
    : 'This address matches a community-maintained registry of known scam/phishing addresses. This is a direct match against an external denylist, not an inference from on-chain behavior.';

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${signalCode}:${address.toLowerCase()}`,
    signalCode,
    polarity: 'risk',
    strength: 'registry_derived',
    addresses: [address],
    entityClassification: classification.type,
    source,
    derivationMethod: 'static_denylist_registry_lookup',
    complete: true,
    note,
  });
}

/**
 * Checks a direct funder without treating the funder's registry match as
 * a direct match on the assessed wallet.
 *
 * @param {string | null | undefined} address
 * @returns {import('../evidence/model.js').EvidenceItem | null}
 */
export function checkKnownRiskFunder(address, opts = {}) {
  if ((opts.chain ?? 'eth') !== 'eth') return null;
  const classification = classifyKnownRisk(address);
  if (!classification) return null;

  const isSanctioned = classification.type === 'sanctioned';
  const signalCode = isSanctioned
    ? SIGNAL_CODES.SANCTIONED_FUNDER
    : SIGNAL_CODES.KNOWN_SCAM_FUNDER;
  const source = isSanctioned
    ? { name: 'ofac_sdn_digital_currency_addresses', asOf: ofacList.fetchedAt }
    : { name: 'scamsniffer_scam_database', asOf: scamList.fetchedAt };
  const note = isSanctioned
    ? 'A direct funder matches the OFAC Specially Designated Nationals sanctions list. This is counterparty context and does not mean the assessed wallet itself appears on the sanctions list.'
    : 'A direct funder matches a community-maintained registry of known scam or phishing addresses. This is counterparty context and does not mean the assessed wallet itself appears on that registry.';

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${signalCode}:${address.toLowerCase()}`,
    signalCode,
    polarity: 'contextual',
    strength: 'registry_derived',
    addresses: [address],
    entityClassification: `${classification.type}_funder`,
    source,
    derivationMethod: 'static_funder_denylist_registry_lookup',
    complete: true,
    note,
  });
}
