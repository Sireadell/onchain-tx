// Contract-control risk (roadmap item, "contract-level risk check" in
// TODO.md, closes parity with the veridex-contract-risk-miner rival on
// the live FRAUD_DETECTION leaderboard). Runs against the assessed
// wallet itself: if it turns out to be a contract, not a normal
// externally-owned wallet, check whether it's a single-owner-controlled
// contract with the capability shape that makes a rug-pull possible
// (upgradeable and/or pausable and/or mintable by that owner). If it's
// an ordinary EOA (the common case) this is a no-op.
//
// Scope note: this checks whether the *subject wallet* is a risky
// contract, not contracts the subject wallet merely interacts with
// (e.g. its funder) -- that's a different, larger feature, deliberately
// not built here. See TODO.md.
//
// eth_getCode is not available on this project's Ankr plan (see
// config.js publicRpcUrl comment) -- this module uses the free public
// RPC client instead. That node's availability is out of this project's
// control, so every call here is best-effort: a failure produces
// `complete: false` coverage, never an exception that kills the whole
// assessment.
//
// EIP-7702 (Pectra) wrinkle, confirmed live 2026-08-24 against
// vitalik.eth: eth_getCode on a normal person's wallet can now return
// non-empty code -- a fixed 23-byte "delegation designator"
// (0xef0100 + 20-byte delegate address), not contract logic living at
// that address. Treating that as "is a contract" would misclassify any
// EOA using account abstraction as a rug-pull-shaped contract. Detected
// and excluded below before the rest of this module ever runs.
//
// Known-exchange/bridge exemption, added after a live false positive
// (2026-08-24): Coinbase's own "Coinbase 10" hot wallet
// (0xa9d1e08c...) turned out to be a single-owner-controlled, pausable
// contract, not a plain EOA -- a real, correctly-detected finding, but
// a pause switch on a regulated exchange's own custody contract is
// normal security practice, not a rug-pull signal. If the assessed
// wallet itself matches the existing known-exchange/bridge registry
// (same one used for funder fan-out context, see knownEntities.js),
// skip flagging it here entirely rather than accuse a legitimate,
// already-identified service wallet.

import { callPublicRpc } from '../rpc/publicChainClient.js';
import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import { classifyKnownEntity } from './knownEntities.js';
import { config } from '../../config.js';

const EIP7702_DELEGATION_PREFIX = '0xef0100';
// 0x + 3-byte prefix (6 hex chars) + 20-byte address (40 hex chars) = 48 chars.
const EIP7702_DELEGATION_CODE_LENGTH = 48;

const OWNER_SELECTOR = '0x8da5cb5b'; // owner()
const PAUSED_SELECTOR = '0x5c975abb'; // paused()
// EIP-1967 implementation storage slot: keccak256("eip1967.proxy.implementation") - 1
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// mint(address,uint256) function selector, searched for directly in the
// deployed bytecode. This is a heuristic, not proof: the selector being
// present only shows the function exists, not that it's unrestricted or
// externally reachable -- reported as an evidence factor, not a verdict.
const MINT_SELECTOR = '40c10f19';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function decodeAddressResult(hexResult) {
  if (typeof hexResult !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hexResult)) return null;
  const stripped = hexResult.slice(2);
  const address = `0x${stripped.slice(-40)}`;
  return address.toLowerCase() === ZERO_ADDRESS ? null : address;
}

function decodeBoolResult(hexResult) {
  if (typeof hexResult !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hexResult)) return null;
  const stripped = hexResult.slice(2);
  if (stripped === '0'.repeat(64)) return false;
  if (stripped === `${'0'.repeat(63)}1`) return true;
  return null;
}

/**
 * Best-effort eth_call, returns null on any failure rather than
 * throwing -- see module comment on why a public-node hiccup should
 * degrade this signal, not the whole assessment.
 */
async function tryCall(client, to, data) {
  try {
    return { complete: true, value: await client('eth_call', [{ to, data }, 'latest']) };
  } catch (err) {
    const expectedAbsence = /execution reverted|revert|selector.*not recognized/i.test(String(err?.message));
    return expectedAbsence
      ? { complete: true, value: '0x' }
      : { complete: false, value: null };
  }
}

/**
 * @param {string} wallet
 * @param {{ url?: string, timeoutMs?: number, deadlineAt?: number, signal?: AbortSignal, callPublicRpc?: typeof callPublicRpc, onCoverage?: (coverage: object) => void }} [opts]
 * @returns {Promise<import('../evidence/model.js').EvidenceItem | null>}
 */
export async function checkContractControlRisk(wallet, opts = {}) {
  if (classifyKnownEntity(wallet, opts.chain ?? config.chain)) {
    opts.onCoverage?.({ complete: true, reason: 'known_exchange_or_bridge_exempt' });
    return null;
  }

  const rpcOpts = {
    chain: opts.chain ?? config.chain,
    ...(opts.url ? { url: opts.url } : {}),
    timeoutMs: opts.timeoutMs ?? config.publicRpcCallTimeoutMs,
    ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  // Injectable for unit tests (same convention as callAnkr elsewhere in
  // src/core/signals/*), defaults to the real public-node client.
  const rawClient = opts.callPublicRpc ?? callPublicRpc;
  const client = (method, params) => rawClient(method, params, rpcOpts);

  let code;
  try {
    code = await client('eth_getCode', [wallet, 'latest']);
  } catch (err) {
    opts.onCoverage?.({ complete: false, reason: 'public_rpc_unavailable' });
    return null;
  }

  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) {
    opts.onCoverage?.({ complete: false, reason: 'malformed_rpc_result' });
    return null;
  }

  if (code === '0x') {
    opts.onCoverage?.({ complete: true, reason: 'not_a_contract' });
    return null;
  }

  if (
    code.length === EIP7702_DELEGATION_CODE_LENGTH
    && code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX)
  ) {
    opts.onCoverage?.({ complete: true, reason: 'eoa_with_eip7702_delegation' });
    return null;
  }

  const [ownerProbe, pausedProbe, implProbe] = await Promise.all([
    tryCall(client, wallet, OWNER_SELECTOR),
    tryCall(client, wallet, PAUSED_SELECTOR),
    client('eth_getStorageAt', [wallet, EIP1967_IMPL_SLOT, 'latest'])
      .then((value) => ({ complete: true, value }))
      .catch(() => ({ complete: false, value: null })),
  ]);

  const ownerAddress = decodeAddressResult(ownerProbe.value);
  const pausable = decodeBoolResult(pausedProbe.value) !== null;
  const upgradeable = decodeAddressResult(implProbe.value) !== null;
  const mintAuthorityDetected = code.toLowerCase().includes(MINT_SELECTOR);
  const ownerResultValid = ownerProbe.value === '0x'
    || (typeof ownerProbe.value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(ownerProbe.value));
  const pausedResultValid = pausedProbe.value === '0x'
    || decodeBoolResult(pausedProbe.value) !== null;
  const implementationResultValid = typeof implProbe.value === 'string'
    && /^0x[0-9a-fA-F]{64}$/.test(implProbe.value);
  const inspectionComplete = ownerProbe.complete
    && pausedProbe.complete
    && implProbe.complete
    && ownerResultValid
    && pausedResultValid
    && implementationResultValid;

  opts.onCoverage?.({
    complete: inspectionComplete,
    reason: inspectionComplete ? 'contract_inspected' : 'contract_inspection_incomplete',
  });

  const ownerControlled = Boolean(ownerAddress);
  const riskFactorCount = [pausable, upgradeable, mintAuthorityDetected].filter(Boolean).length;

  // Nothing notable to report: either no owner() pattern detected, or an
  // owner exists but none of the dangerous capabilities do. Matches the
  // rest of the codebase's convention of returning null rather than
  // emitting noise evidence for an unremarkable finding.
  if (!ownerControlled || riskFactorCount === 0) {
    return null;
  }

  const factors = [];
  if (pausable) factors.push('can pause the contract');
  if (upgradeable) factors.push('can upgrade its logic entirely (proxy pattern detected)');
  if (mintAuthorityDetected) factors.push('the bytecode contains a mint(address,uint256) function');

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.CONTRACT_CONTROL_RISK}:${wallet.toLowerCase()}`,
    signalCode: SIGNAL_CODES.CONTRACT_CONTROL_RISK,
    polarity: 'contextual',
    strength: 'direct',
    addresses: [wallet, ownerAddress],
    metrics: {
      isContract: true,
      ownerControlled: true,
      pausable,
      upgradeable,
      mintAuthorityDetected,
    },
    derivationMethod: 'eth_call owner()/paused() + EIP-1967 implementation slot + bytecode selector scan',
    entityClassification: 'contract',
    rpcMethod: 'eth_call/eth_getStorageAt',
    complete: inspectionComplete,
    note: `This address is a smart contract controlled by a single owner address (${ownerAddress}), and that owner ${factors.join(', ')}. These controls remain visible for review, but they do not independently establish fraud because legitimate contracts may use the same controls for security or maintenance.`,
  });
}
