// Live solvency risk (TODO.md "Live solvency check", closes parity with
// the `anchor` rival on the live FRAUD_DETECTION leaderboard). Runs
// against the assessed wallet itself: does it have a real, live lending
// position on Aave v3, and if so, can it actually cover what it owes
// right now -- not just whether its funding history looks clean.
//
// Scope: Ethereum mainnet Aave v3 only, matching config.chain's actual
// value ('eth', see config.js) -- Anchor's own version of this check
// targets Base instead, but Sentinel's funding-relationship analysis
// already runs against Ethereum mainnet, so this stays on the same
// chain as everything else Sentinel says about the wallet, rather than
// silently answering a different chain's question.
//
// Pool address (0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2) confirmed
// live 2026-08-24 directly from aave.com/docs/resources/addresses (V3
// tab, Ethereum, "Pool" row) and live-tested via eth_call before
// shipping -- not taken from a web-search summary, which independently
// suggested a different, wrong address for this same lookup while
// researching this feature (a live reminder of why a live eth_call
// against the docs-sourced address is worth the extra step over
// trusting a paraphrase).
//
// Same RPC gap as contractControlRisk.js: eth_call isn't available on
// this project's Ankr plan, so this reuses the same free public-node
// client. Same degrade-gracefully contract: a public-node failure marks
// this one signal `partial`, never the whole assessment.

import { callPublicRpc } from '../rpc/publicChainClient.js';
import { makeEvidenceItem, SIGNAL_CODES } from '../evidence/model.js';
import { config } from '../../config.js';

// Ethereum mainnet Aave v3 Pool proxy. See module comment for provenance.
const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const GET_USER_ACCOUNT_DATA_SELECTOR = '0xbf92857c'; // getUserAccountData(address)

// Aave v3's sentinel value for "no debt, healthFactor is not meaningful"
// -- literally uint256 max, per the protocol's own convention, not a
// magic number invented here.
const NO_DEBT_HEALTH_FACTOR = (1n << 256n) - 1n;
const WAD = 10n ** 18n; // healthFactor fixed-point scale
const BASE_CURRENCY_DECIMALS = 10n ** 8n; // Aave v3 Ethereum market's base currency is USD, 8 decimals

// Thresholds are provisional, not final -- same discipline as the
// ELEVATED-tier triggers in scoring/index.js: capped conservative until
// validated against a larger ground-truth benchmark than the current
// set. 1.0 is the protocol's own liquidation-eligibility line, not a
// choice made here; 1.2 is a "close enough to worry about" margin above
// it, not sourced from Aave itself.
const ALREADY_LIQUIDATABLE_THRESHOLD = WAD; // healthFactor < 1.0
const CLOSE_TO_LIQUIDATION_THRESHOLD = (WAD * 12n) / 10n; // healthFactor < 1.2

function decodeGetUserAccountData(hexResult) {
  const stripped = hexResult.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{384}$/.test(stripped)) return null;
  const words = [];
  for (let i = 0; i < 6; i += 1) {
    words.push(BigInt(`0x${stripped.slice(i * 64, (i + 1) * 64) || '0'}`));
  }
  const [totalCollateralBase, totalDebtBase, , , , healthFactor] = words;
  return { totalCollateralBase, totalDebtBase, healthFactor };
}

function toUsdString(baseUnits) {
  const whole = baseUnits / BASE_CURRENCY_DECIMALS;
  const cents = ((baseUnits % BASE_CURRENCY_DECIMALS) * 100n) / BASE_CURRENCY_DECIMALS;
  return `$${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

function healthFactorToDecimalString(healthFactor) {
  const whole = healthFactor / WAD;
  const frac = ((healthFactor % WAD) * 1000n) / WAD;
  return `${whole.toString()}.${frac.toString().padStart(3, '0')}`;
}

/**
 * @param {string} wallet
 * @param {{ callPublicRpc?: typeof callPublicRpc, url?: string, timeoutMs?: number, deadlineAt?: number, signal?: AbortSignal, onCoverage?: (coverage: object) => void }} [opts]
 * @returns {Promise<import('../evidence/model.js').EvidenceItem | null>}
 */
export async function checkLiveSolvencyRisk(wallet, opts = {}) {
  if ((opts.chain ?? config.chain) !== 'eth') {
    opts.onCoverage?.({ complete: false, skipped: true, reason: 'unsupported_on_base' });
    return null;
  }
  const rpcOpts = {
    chain: opts.chain ?? config.chain,
    ...(opts.url ? { url: opts.url } : {}),
    timeoutMs: opts.timeoutMs ?? config.publicRpcCallTimeoutMs,
    ...(opts.deadlineAt ? { deadlineAt: opts.deadlineAt } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const rawClient = opts.callPublicRpc ?? callPublicRpc;
  const client = (method, params) => rawClient(method, params, rpcOpts);

  const paddedWallet = wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = `${GET_USER_ACCOUNT_DATA_SELECTOR}${paddedWallet}`;

  let result;
  try {
    result = await client('eth_call', [{ to: AAVE_V3_POOL, data }, 'latest']);
  } catch (err) {
    opts.onCoverage?.({ complete: false, reason: 'public_rpc_unavailable' });
    return null;
  }

  if (!result || result === '0x') {
    opts.onCoverage?.({ complete: false, reason: 'malformed_rpc_result' });
    return null;
  }

  const decoded = decodeGetUserAccountData(result);
  if (!decoded) {
    opts.onCoverage?.({ complete: false, reason: 'malformed_rpc_result' });
    return null;
  }
  const { totalCollateralBase, totalDebtBase, healthFactor } = decoded;

  if (totalDebtBase === 0n || healthFactor === NO_DEBT_HEALTH_FACTOR) {
    opts.onCoverage?.({ complete: true, reason: 'no_live_debt_position' });
    return null;
  }

  opts.onCoverage?.({ complete: true, reason: 'live_position_inspected' });

  if (healthFactor >= CLOSE_TO_LIQUIDATION_THRESHOLD) {
    return null;
  }

  const alreadyLiquidatable = healthFactor < ALREADY_LIQUIDATABLE_THRESHOLD;
  const healthFactorStr = healthFactorToDecimalString(healthFactor);

  const note = alreadyLiquidatable
    ? `This wallet has a live Aave v3 lending position on Ethereum mainnet with a health factor of ${healthFactorStr} -- below 1.0, meaning it is already eligible for liquidation right now. Total collateral: ${toUsdString(totalCollateralBase)}, total debt: ${toUsdString(totalDebtBase)}. This is live, current protocol state, not history -- it reflects real-time ability to cover its debt, which can change as soon as the next block.`
    : `This wallet has a live Aave v3 lending position on Ethereum mainnet with a health factor of ${healthFactorStr} -- above the 1.0 liquidation line but close enough that a modest adverse price move could push it into liquidation. Total collateral: ${toUsdString(totalCollateralBase)}, total debt: ${toUsdString(totalDebtBase)}. This is live, current protocol state, not history.`;

  return makeEvidenceItem({
    ...(opts.chainId ? { chainId: opts.chainId } : {}),
    evidenceId: `${SIGNAL_CODES.LIVE_SOLVENCY_RISK}:${wallet.toLowerCase()}`,
    signalCode: SIGNAL_CODES.LIVE_SOLVENCY_RISK,
    polarity: 'contextual',
    strength: 'direct',
    addresses: [wallet],
    metrics: {
      hasLiveDebtPosition: true,
      alreadyLiquidatable,
      healthFactor: healthFactorStr,
      totalCollateralUsd: toUsdString(totalCollateralBase),
      totalDebtUsd: toUsdString(totalDebtBase),
    },
    derivationMethod: 'eth_call Aave v3 Pool.getUserAccountData(address)',
    entityClassification: 'live_lending_position',
    rpcMethod: 'eth_call',
    source: { name: 'aave_v3_ethereum_pool', asOf: '2026-08-24' },
    complete: true,
    note,
  });
}
