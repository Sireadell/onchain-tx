// P1 signal: known-entity classification (LOCKED_SPEC roadmap item 8,
// exchange + bridge subsets — generic "is this any contract" detection
// deliberately NOT covered here, since it needs a new RPC call per funder
// and Sentinel is tight against its p90 < 15s latency budget; a
// registry lookup like this one costs nothing. See docs/LOCKED_SPEC.md
// item 8/9 and HANDOFF.md).
//
// Pure registry lookup, no RPC call: classifies a funder address against a
// known-exchange denylist. EXCULPATORY, not risk-bearing — the point is to
// explain *why* a funder shows fan-out/cluster behavior (see fanOut.js,
// clustering.js), not to itself accuse anything. Never let this raise
// risk_score or risk_level.
//
// Address list + KNOWN_EXCHANGE_ADDRESSES env var pattern ported from
// PulseVerify's src/lib/knownExchanges.js (C:\Users\DELL\pulseverify) —
// same provenance rule applies: every built-in entry below was confirmed
// against a live explorer label, not guessed or pulled from memory.
//
// Provenance: Ethereum-mainnet entries, Etherscan public name tags.
// OKX entries confirmed live 2026-07-12 (ported unchanged from PulseVerify's
// list). All other exchanges (Binance, Coinbase, Kraken, HTX/Huobi, KuCoin,
// Crypto.com, Gate.io, Bitfinex, Gemini, Bitstamp, Upbit) added 2026-08-19,
// sourced from brianleect/etherscan-labels (github.com/brianleect/
// etherscan-labels) and individually re-verified against each address's
// live Etherscan name tag before inclusion — several candidates from that
// dump were rejected because their Etherscan label had since gone stale
// (unlabeled) or pointed at a token/deployer contract, not a wallet.
// Re-verify before adding new chains — these are mainnet-only, do not
// assume they're valid on other chains without checking.

import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import { config } from '../../config.js';

const BUILT_IN_EXCHANGE_ADDRESSES = [
  '0x4b4e14a3773ee558b6597070797fd51eb48606e5', // "OKX: Hot Wallet"
  '0x4e7b110335511f662fdbb01bf958a7844118c0d4', // "OKX: Hot Wallet 2"
  '0xa9ac43f5b5e38155a288d1a01d2cbc4478e14573', // "OKX: Hot Wallet 3"
  '0x559432e18b281731c054cd703d4b49872be4ed53', // "OKX: Hot Wallet 5"
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b', // "OKX"
  '0xa7efae728d2936e78bda97dc267687568dd593f3', // "OKX 3"
  '0x3d55ccb2a943d88d39dd2e62daf767c69fd0179f', // "OKX 23"
  '0xbf94f0ac752c739f623c463b5210a7fb2cbb420b', // "OKX 24"
  '0x96fdc631f02207b72e5804428dee274cf2ac0bcd', // "OKX: OKX wallet"
  // Binance
  '0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be', // "Binance"
  '0x85b931a32a0725be14285b66f1a22178c672d69b', // "Binance 10"
  '0x708396f17127c42383e3b9014072679b2f60b82f', // "Binance 11"
  '0xe0f0cfde7ee664943906f17f7f14342e76a5cec7', // "Binance 12"
  '0x8f22f2063d253846b53609231ed80fa571bc0c8f', // "Binance 13"
  '0x28c6c06298d514db089934071355e5743bf21d60', // "Binance 14"
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549', // "Binance 15"
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d', // "Binance 16"
  // Coinbase
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3', // "Coinbase 1"
  '0x77696bb39917c91a0c3908d577d5e322095425ca', // "Coinbase 3"
  '0x7c195d981abfdc3ddecd2ca0fed0958430488e34', // "Coinbase 4"
  '0x95a9bd206ae52c4ba8eecfc93d18eacdd41c88cc', // "Coinbase 5"
  '0xb739d0895772dbb71a89a3754a160269068f0d45', // "Coinbase 6"
  '0x503828976d22510aad0201ac7ec88293211d23da', // "Coinbase 12"
  '0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740', // "Coinbase 23"
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43', // "Coinbase 10", added 2026-08-24 (contractControlRisk.js false-positive fix)
  // Kraken
  '0x2910543af39aba0cd09dbb2d50200b3e800a63d2', // "Kraken 1"
  '0xae2d4617c862309a3d75a0ffb358c7a5009c673f', // "Kraken 10"
  '0x43984d578803891dfa9706bdeee6078d80cfc79e', // "Kraken 11"
  '0x66c57bf505a85a74609d2c83e94aabb26d691e1f', // "Kraken 12"
  '0xda9dfa130df4de4673b89022ee50ff26f6ea73cf', // "Kraken 13"
  '0xa83b11093c858c86321fbc4c20fe82cdbd58e09e', // "Kraken 14"
  '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13', // "Kraken 2"
  '0xe853c56864a2ebe4576a807d26fdc4a0ada51919', // "Kraken 3"
  // HTX (formerly Huobi)
  '0xab5c66752a9e8167967685f1450532fb96d5d24f', // "HTX 1"
  '0xe93381fb4c4f14bda253907b18fad305d799241a', // "HTX 2"
  '0xfa4b5be3f2f84f56703c42eb22142744e95a2c58', // "HTX 3"
  '0x46705dfff24256421a05d056c29e81bdc09723b8', // "HTX 4"
  '0x32598293906b5b17c27d657db3ad2c9b3f3e4265', // "HTX 5"
  '0x5861b8446a2f6e19a067874c133f04c578928727', // "HTX 6"
  '0x926fc576b7facf6ae2d08ee2d4734c134a743988', // "HTX 7"
  '0xeec606a66edb6f497662ea31b5eb1610da87ab5f', // "HTX 8"
  // KuCoin
  '0x2b5634c42055806a59e9107ed44d43c426e58258', // "KuCoin 1"
  '0xcad621da75a66c7a8f4ff86d30a2bf981bfc8fdd', // "KuCoin 10"
  '0xec30d02f10353f8efc9601371f56e808751f396f', // "KuCoin 11"
  '0x738cf6903e6c4e699d1c2dd9ab8b67fcdb3121ea', // "KuCoin 12"
  '0xd89350284c7732163765b23338f2ff27449e0bf5', // "KuCoin 13"
  '0x88bd4d3e2997371bceefe8d9386c6b5b4de60346', // "KuCoin 14"
  '0xb8e6d31e7b212b2b7250ee9c26c56cebbfbe6b23', // "KuCoin 15"
  '0x689c56aef474df92d44a1b70850f808488f9769c', // "KuCoin 2"
  // Crypto.com
  '0x6262998ced04146fa42253a5c0af90ca02dfd2a3', // "Crypto.com 1"
  '0x46340b20830761efd32832a74d7169b29feb9758', // "Crypto.com 12"
  '0x72a53cdbbcc1b9efa39c834a540550e23463aacb', // "Crypto.com 14"
  '0x7758e507850da48cd47df1fb5f875c23e3340c50', // "Crypto.com 4"
  '0xcffad3200574698b78f32232aa9d63eabd290703', // "Crypto.com 16"
  // Gate.io
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe', // "Gate Deposit"
  '0x7793cd85c11a924478d358d49b05b37e91b5810f', // "Gate Deposit"
  '0x1c4b70a3968436b9a0a9cf5205c787eb81bb558c', // "Gate Deposit"
  '0x234ee9e35f8e9749a002fc42970d570db716453b', // "Gate Deposit"
  '0xc882b111a75c0c657fc507c04fbfcd2cc984f071', // "Gate Deposit"
  '0x6596da8b65995d5feacff8c2936f0b7a2051b0d0', // "Gate: Deposit Funder"
  // Bitfinex
  '0x1151314c646ce4e0efd76d1af4760ae66a9fe30f', // "Bitfinex 1"
  '0x36a85757645e8e8aec062a1dee289c7d615901ca', // "Bitfinex 10"
  '0xc56fefd1028b0534bfadcdb580d3519b5586246e', // "Bitfinex 11"
  '0x0b73f67a49273fc4b9a65dbd25d7d0918e734e63', // "Bitfinex 12"
  '0x482f02e8bc15b5eabc52c6497b425b3ca3c821e8', // "Bitfinex 13"
  '0xe92d1a43df510f82c66382592a047d288f85226f', // "Bitfinex 19"
  '0x742d35cc6634c0532925a3b844bc454e4438f44e', // "Bitfinex 2"
  '0x8103683202aa8da10536036edef04cdd865c225e', // "Bitfinex 20"
  // Gemini
  '0xd24400ae8bfebb18ca49be86258a3c749cf46853', // "Gemini"
  // Bitstamp
  '0x00bdb5699745f5b860228c8f939abf1b9ae374ed', // "Bitstamp 1"
  '0x9a9bed3eb03e386d66f8a29dc67dc29bbb1ccb72', // "Bitstamp 3"
  '0x059799f2261d37b829c2850cee67b5b975432271', // "Bitstamp 4"
  '0x4c766def136f59f6494f0969b1355882080cf8e0', // "Bitstamp 5"
  '0xc5b611f502a0dcf6c3188fd494061ae29b2baa4f', // "Bitstamp 6"
  // Upbit
  '0x390de26d772d2e2005c6d1d24afc902bae37a4bb', // "Upbit 1"
  '0xba826fec90cefdf6706858e5fbafcb27a290fbe0', // "Upbit 2"
  '0x5e032243d507c743b061ef021e2ec7fcc6d3ab89', // "Upbit 3"
];

const builtInSet = new Set(BUILT_IN_EXCHANGE_ADDRESSES.map((a) => a.toLowerCase()));

// Ethereum-mainnet L1 bridge contracts for the four highest-usage
// rollups/sidechains at time of writing. Each address was individually
// confirmed against its live Etherscan public name tag before inclusion
// (same provenance bar as the exchange list above), sourced from each
// project's own official docs, not a third-party dump. Not exhaustive —
// deliberately scoped to the largest, best-documented bridges rather than
// trying to cover every bridge in existence; add more here as needed,
// same verification bar.
const BUILT_IN_BRIDGE_ADDRESSES = [
  // Arbitrum One, confirmed 2026-08-20 against docs.arbitrum.io + Etherscan
  '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f', // "Arbitrum: Delayed Inbox"
  '0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a', // "Arbitrum: Bridge"
  '0x72ce9c846789fdb6fc1f34ac4ad25dd9ef7031ef', // "Arbitrum One: L1 Gateway Router"
  '0xa3a7b6f88361f48403514059f1f16c8e78d60eec', // "Arbitrum One: L1 ERC20 Gateway"
  // Optimism (OP Mainnet), confirmed 2026-08-20 against docs.optimism.io + Etherscan
  '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1', // "Optimism: Gateway" (L1StandardBridgeProxy)
  '0xbeb5fc579115071764c7423a4f12edde41f106ed', // "Optimism: Portal" (OptimismPortalProxy)
  // Base, confirmed 2026-08-20 against docs.base.org + Etherscan
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35', // "Base: Base Bridge" (L1StandardBridge)
  // Polygon PoS, confirmed 2026-08-20 against docs.polygon.technology + Etherscan
  '0xa0c68c638235ee32657e8f720a23cec1bfc77c77', // "Polygon (Matic): Bridge" (RootChainManagerProxy)
];

const builtInBridgeSet = new Set(BUILT_IN_BRIDGE_ADDRESSES.map((a) => a.toLowerCase()));

/**
 * @param {string | null | undefined} address
 * @returns {{ type: 'known_exchange' | 'known_bridge' } | null}
 */
export function classifyKnownEntity(address, chain = 'eth') {
  if (!address) return null;
  if (chain !== 'eth') return null;
  const normalized = address.toLowerCase();
  if (builtInSet.has(normalized) || config.knownExchangeAddresses.includes(normalized)) {
    return { type: 'known_exchange' };
  }
  if (builtInBridgeSet.has(normalized)) {
    return { type: 'known_bridge' };
  }
  return null;
}

/**
 * @param {string | null | undefined} funderAddress
 * @returns {import('../evidence/model.js').EvidenceItem | null}
 */
export function checkKnownExchangeFunder(funderAddress, opts = {}) {
  const classification = classifyKnownEntity(funderAddress, opts.chain);
  if (classification?.type !== 'known_exchange') return null;

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.KNOWN_EXCHANGE_FUNDER}:${funderAddress.toLowerCase()}`,
    signalCode: SIGNAL_CODES.KNOWN_EXCHANGE_FUNDER,
    polarity: 'exculpatory',
    strength: 'registry_derived',
    addresses: [funderAddress],
    entityClassification: classification.type,
    source: { name: 'sentinel_known_exchange_registry', asOf: '2026-08-19' },
    derivationMethod: 'static_address_registry_lookup',
    complete: true,
    note: 'The direct funder address matches a known centralized-exchange wallet. This explains, rather than raises, any observed fan-out or funding-cluster behavior from that funder.',
  });
}

/**
 * @param {string | null | undefined} funderAddress
 * @returns {import('../evidence/model.js').EvidenceItem | null}
 */
export function checkKnownBridgeFunder(funderAddress, opts = {}) {
  const classification = classifyKnownEntity(funderAddress, opts.chain);
  if (classification?.type !== 'known_bridge') return null;

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.KNOWN_BRIDGE_FUNDER}:${funderAddress.toLowerCase()}`,
    signalCode: SIGNAL_CODES.KNOWN_BRIDGE_FUNDER,
    polarity: 'exculpatory',
    strength: 'registry_derived',
    addresses: [funderAddress],
    entityClassification: classification.type,
    source: { name: 'sentinel_known_bridge_registry', asOf: '2026-08-20' },
    derivationMethod: 'static_address_registry_lookup',
    complete: true,
    note: 'The direct funder address matches a known cross-chain bridge contract. This explains, rather than raises, any observed fan-out or funding-cluster behavior from that funder.',
  });
}

/**
 * Checks whether the ASSESSED address is itself a publicly identified
 * exchange or bridge address, rather than merely being funded by one.
 *
 * Added 2026-08-28. The registries above already held these addresses,
 * but were only ever consulted against a funder, so a live question
 * about Binance 14 (0x28c6...1d60, in BUILT_IN_EXCHANGE_ADDRESSES since
 * day one) came back as "LIMITED, confidence 0.35, bounded observation
 * did not support a conclusion" rather than naming what the address
 * plainly is. Confirmed against the real explorer question feed.
 *
 * Returns null for an ordinary address (the common case, proceed with
 * normal scoring).
 *
 * @param {string | null | undefined} wallet
 * @returns {import('../evidence/model.js').EvidenceItem | null}
 */
export function checkSubjectKnownEntity(wallet) {
  const classification = classifyKnownEntity(wallet);
  if (!classification) return null;

  const isExchange = classification.type === 'known_exchange';
  const note = isExchange
    ? 'This address is itself a publicly identified centralized-exchange wallet, not an anonymous or unattributed one. Exchange wallets pool funds from many customers and move large volumes by design, so ordinary funding-relationship risk signals (fan-out, funding clusters, high throughput) describe normal custodial operation here and are not evidence of fraud. Note the limits of that: identifying the operator is not a clean bill of health for any individual deposit, withdrawal, or customer behind it, and it says nothing about the solvency or conduct of the operator itself.'
    : 'This address is itself a publicly identified cross-chain bridge contract, not an ordinary wallet. Bridges pool and forward funds for many unrelated users by design, so funding-relationship risk signals describe normal bridge operation here and are not evidence of fraud. This identifies the contract; it is not a safety or solvency judgement about the bridge or about any individual transfer through it.';

  return makeEvidenceItem({
    evidenceId: `${isExchange ? SIGNAL_CODES.SUBJECT_KNOWN_EXCHANGE : SIGNAL_CODES.SUBJECT_KNOWN_BRIDGE}:${wallet.toLowerCase()}`,
    signalCode: isExchange
      ? SIGNAL_CODES.SUBJECT_KNOWN_EXCHANGE
      : SIGNAL_CODES.SUBJECT_KNOWN_BRIDGE,
    polarity: 'exculpatory',
    strength: 'registry_derived',
    addresses: [wallet],
    entityClassification: classification.type,
    source: {
      name: isExchange
        ? 'sentinel_known_exchange_registry'
        : 'sentinel_known_bridge_registry',
      asOf: isExchange ? '2026-08-19' : '2026-08-20',
    },
    derivationMethod: 'static_address_registry_lookup',
    complete: true,
    note,
  });
}
