// FRAUD_DETECTION signal endpoint. The initial Sentinel Core path is
// intentionally narrow: direct funder, direct circular funding, and
// bounded direct-funder fan-out only.
//
// Endpoint shape intentionally mirrors the old project's
// src/routes/checkWallet.js (GET/POST, `wallet` param) since that
// contract already works with Telegraph's dispatcher; only the response
// schema changes (see docs/LOCKED_SPEC.md "Public risk output").

import { Router } from 'express';
import { isAddress } from 'ethers';
import { config } from '../config.js';
import {
  withRpcBudget,
  assertRpcBudgetAvailable,
  ApiKeyMissingError,
  RpcBudgetExceededError,
} from '../core/rpc/ankrClient.js';
import {
  makeUnavailableAssessment,
  makeNotApplicableAssessment,
  makeKnownEntityAssessment,
} from '../core/assessment/model.js';
import {
  findDirectFunder,
  checkDirectCircularFunding,
  analyzeFunderFanOut,
  recordAndGetFundingCluster,
  checkKnownExchangeFunder,
  checkKnownBridgeFunder,
  checkKnownRiskAddress,
  checkKnownRiskFunder,
  checkSubjectApplicability,
  checkSubjectKnownEntity,
  checkConvergentRelayFunding,
  checkContractControlRisk,
  checkLiveSolvencyRisk,
} from '../core/signals/index.js';
import { computeAssessment } from '../core/scoring/index.js';
import { observeDirectOutbound } from '../core/signals/outboundRelationships.js';
import { getChainConfig, normalizeChain, SUPPORTED_CHAIN_KEYS } from '../core/chains.js';

const router = Router();

/**
 * Runs the deliberately narrow synchronous Sentinel Core path. `callAnkr`
 * is injectable for unit tests; production omits it and uses the bounded
 * transport imported by each signal.
 */
export async function runFastAssessment(wallet, opts = {}) {
  const chain = normalizeChain(opts.chain);
  if (!chain) throw new Error(`unsupported chain; use one of: ${SUPPORTED_CHAIN_KEYS.join(', ')}`);
  const chainConfig = getChainConfig(chain);
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const evidence = [];
  const coverage = {};
  const signalOptions = {
    chain,
    chainId: chainConfig.chainId,
    ...(opts.callAnkr ? { callAnkr: opts.callAnkr } : {}),
  };
  if (chain === 'base') {
    coverage.known_risk_registry = { status: 'skipped', reason: 'ethereum_registry_not_applied_to_base' };
    coverage.known_entity_registry = { status: 'skipped', reason: 'ethereum_registry_not_applied_to_base' };
    coverage.known_mixer_registry = { status: 'skipped', reason: 'ethereum_registry_not_applied_to_base' };
  }

  // Pure registry lookup, no RPC call: is the subject itself even a
  // standard fundable wallet? A burn/null address or known pooling/mixer
  // contract short-circuits here rather than falling through to
  // funding-relationship scoring, which structurally doesn't apply to
  // either (see subjectApplicability.js). This must run before anything
  // else -- there's no point spending RPC budget analyzing funders of an
  // address that was never a normal wallet to begin with.
  const subjectApplicabilityEvidence = checkSubjectApplicability(wallet, signalOptions);
  if (subjectApplicabilityEvidence) {
    const assessment = makeNotApplicableAssessment(wallet, subjectApplicabilityEvidence, {
      latencyMs: now() - startedAt,
    });
    assessment.chain = chain;
    assessment.chain_id = chainConfig.chainId;
    return assessment;
  }

  // Pure registry lookup, no RPC call, no coverage entry needed (always
  // complete): checks the assessed wallet itself against the OFAC
  // sanctions and known-scam denylists before anything else, since it
  // doesn't depend on funder history and a direct hit is risk-bearing on
  // its own (see knownRisk.js).
  const walletKnownRiskEvidence = checkKnownRiskAddress(wallet, signalOptions);
  if (walletKnownRiskEvidence) evidence.push(walletKnownRiskEvidence);

  // Also a pure registry lookup, no RPC call: is the subject ITSELF a
  // publicly identified exchange or bridge address? If so we already
  // know what it is, and grinding through funder/fan-out analysis would
  // only produce the "bounded observation did not support a conclusion"
  // non-answer that this short-circuit exists to replace (see
  // knownEntities.js checkSubjectKnownEntity).
  //
  // Ordered deliberately AFTER the sanctions/scam denylist check above:
  // a denylist hit must always win, so an address that is on both lists
  // (a sanctioned exchange, say) falls through to full scoring and is
  // never explained away as "just an exchange."
  if (!walletKnownRiskEvidence) {
    const subjectKnownEntityEvidence = checkSubjectKnownEntity(wallet);
    if (subjectKnownEntityEvidence) {
      return makeKnownEntityAssessment(wallet, subjectKnownEntityEvidence, {
        latencyMs: now() - startedAt,
      });
    }
  }

  const optionalDeadlineMs = opts.optionalSignalDeadlineMs ?? config.optionalSignalDeadlineMs;
  const optionalDeadlineAt = Date.now() + optionalDeadlineMs;
  const optionalController = new AbortController();
  const optionalTimer = setTimeout(
    () => optionalController.abort(new Error('optional signal deadline exceeded')),
    optionalDeadlineMs,
  );

  // Runs against a separate, unauthenticated public RPC node (Ankr's
  // plan on this account doesn't support eth_getCode/eth_call, see
  // config.js), so it shares neither budget nor rate limiter with the
  // rest of this function -- safe to run fully in parallel with the
  // funder lookup below rather than adding to its latency.
  const contractControlRiskPromise = checkContractControlRisk(wallet, {
    ...signalOptions,
    ...(opts.callPublicRpc ? { callPublicRpc: opts.callPublicRpc } : {}),
    deadlineAt: optionalDeadlineAt,
    signal: optionalController.signal,
    onCoverage: (scan) => {
      coverage.contract_control_risk = scan.complete
        ? { status: 'complete', reason: scan.reason }
        : { status: 'partial', reason: scan.reason };
    },
  });

  // Same separate public-node path as contract-control risk above, same
  // reasoning for running in parallel: does the wallet have a real,
  // live Aave v3 lending position it may not be able to cover right
  // now, independent of anything about its funding history.
  const liveSolvencyRiskPromise = checkLiveSolvencyRisk(wallet, {
    ...signalOptions,
    ...(opts.callPublicRpc ? { callPublicRpc: opts.callPublicRpc } : {}),
    deadlineAt: optionalDeadlineAt,
    signal: optionalController.signal,
    onCoverage: (scan) => {
      coverage.live_solvency_risk = scan.skipped
        ? { status: 'skipped', reason: scan.reason }
        : scan.complete
        ? { status: 'complete', reason: scan.reason }
        : { status: 'partial', reason: scan.reason };
    },
  });

  const funderEvidence = await findDirectFunder(wallet, {
    ...signalOptions,
    onCoverage: (scan) => {
      coverage.funding_relationship = scan.complete
        ? { status: 'complete' }
        : { status: 'partial', reason: scan.reason };
    },
  });
  assertRpcBudgetAvailable();
  if (funderEvidence) evidence.push(funderEvidence);

  const [contractControlRiskEvidence, liveSolvencyRiskEvidence] = await Promise.all([
    contractControlRiskPromise,
    liveSolvencyRiskPromise,
  ]);
  clearTimeout(optionalTimer);
  if (contractControlRiskEvidence) evidence.push(contractControlRiskEvidence);
  if (liveSolvencyRiskEvidence) evidence.push(liveSolvencyRiskEvidence);

  const relevantFunders = funderEvidence?.relevantFunders ?? [];
  if (relevantFunders.length > 0) {
    // checkDirectCircularFunding scans the wallet's own outbound history
    // once regardless of how many funders it's matched against, so
    // checking it against the whole bounded relevantFunders set costs
    // nothing extra -- this is what lets a wallet whose earliest funder
    // was dust still get correctly flagged for circular funding against
    // its real, later funder.
    //
    // observeDirectOutbound is the expensive side (one full bounded
    // scan per funder: up to 5 native + 5 token pages). Measured live
    // against the Ronin Bridge Exploiter wallet (2 relevant funders),
    // running it for every relevant funder pushed latency from ~7s to
    // past the 22s hard cutoff (UNAVAILABLE) -- see
    // benchmark/ground-truth-results.before-fix.json for the prior
    // baseline. Fan-out/clustering are contextual-only signals (never
    // independently risk-bearing, see CIRCUMSTANTIAL_ONLY_CODES), so
    // it's a reasonable, bounded trade-off to run that expensive step
    // against only one funder: whichever one circular-funding actually
    // matched (most informative, since we already know it's implicated
    // in a risk-bearing relationship), or the primary relevant funder
    // otherwise.
    const circularEvidence = await checkDirectCircularFunding(wallet, relevantFunders, {
      ...signalOptions,
      onCoverage: (scan) => {
        coverage.direct_circular_funding = scan.complete
          ? { status: 'complete' }
          : { status: 'partial', reason: scan.reason };
      },
    });
    assertRpcBudgetAvailable();

    const matchedFunder = relevantFunders.find(
      (address) => address.toLowerCase() === circularEvidence?.asset?.to?.toLowerCase()
    );
    const fanOutFunder = matchedFunder ?? relevantFunders[0];
    const outboundObservation = await observeDirectOutbound(fanOutFunder, signalOptions);
    const [fanOutEvidence, clusterEvidence, convergentRelayEvidence] = await Promise.all([
      analyzeFunderFanOut(fanOutFunder, {
        ...signalOptions,
        observation: outboundObservation,
        // Coverage records which funder fan-out/cluster actually
        // analyzed, not just that some funder was: relevantFunders can
        // hold more than one address, and only one is ever selected for
        // this expensive step (see fanOutFunder above), so without this
        // a reader can't tell which one a "checked, found nothing"
        // result refers to.
        onCoverage: (scan) => {
          coverage.funder_fan_out = scan.complete
            ? { status: 'complete', funder: fanOutFunder }
            : { status: 'partial', reason: scan.reason, funder: fanOutFunder };
        },
      }),
      recordAndGetFundingCluster(fanOutFunder, wallet, {
        ...signalOptions,
        observation: outboundObservation,
        onCoverage: (scan) => {
          coverage.funding_cluster = scan.complete
            ? { status: 'complete', funder: fanOutFunder }
            : { status: 'partial', reason: scan.reason, funder: fanOutFunder };
        },
      }),
      // Convergent Relay Funding: catches the Sybil case fan-out/cluster
      // can't -- a different disposable funder per target wallet, all
      // fed from one shared upstream address. Only does real work (2 more
      // bounded, 1-page-each lookups) when there are 2 distinct relevant
      // funders to compare; a no-op otherwise. See
      // convergentRelayFunding.js.
      checkConvergentRelayFunding(wallet, relevantFunders, funderEvidence?.relationships, {
        ...signalOptions,
        onCoverage: (scan) => {
          coverage.convergent_relay_funding = scan.complete
            ? {
                status: 'complete',
                ...(scan.checkedFunders ? { checkedFunders: scan.checkedFunders } : {}),
                ...(scan.reason ? { reason: scan.reason } : {}),
              }
            : { status: 'partial', reason: scan.reason };
        },
      }),
    ]);

    // Pure registry lookup, no RPC call, no coverage entry needed (always
    // complete): explains fan-out/cluster context rather than judging it.
    const knownExchangeEvidence = checkKnownExchangeFunder(fanOutFunder, signalOptions);
    const knownBridgeEvidence = checkKnownBridgeFunder(fanOutFunder, signalOptions);

    // Also a pure registry lookup: checked against every relevant funder
    // (not just fanOutFunder), since it's free and a sanctioned/scam
    // funder is risk-bearing regardless of which one got selected for
    // the expensive fan-out/cluster scan above.
    const funderKnownRiskEvidence = relevantFunders
      .map((funder) => checkKnownRiskFunder(funder, signalOptions))
      .filter(Boolean);

    if (circularEvidence) evidence.push(circularEvidence);
    if (fanOutEvidence) evidence.push(fanOutEvidence);
    if (clusterEvidence) evidence.push(clusterEvidence);
    if (convergentRelayEvidence) evidence.push(convergentRelayEvidence);
    if (knownExchangeEvidence) evidence.push(knownExchangeEvidence);
    if (knownBridgeEvidence) evidence.push(knownBridgeEvidence);
    evidence.push(...funderKnownRiskEvidence);
  } else {
    coverage.direct_circular_funding = {
      status: 'skipped',
      reason: 'no_direct_funder_observed',
    };
    coverage.funder_fan_out = {
      status: 'skipped',
      reason: 'no_direct_funder_observed',
    };
    coverage.funding_cluster = {
      status: 'skipped',
      reason: 'no_direct_funder_observed',
    };
    coverage.convergent_relay_funding = {
      status: 'skipped',
      reason: 'no_direct_funder_observed',
    };
  }

  assertRpcBudgetAvailable();
  const assessment = computeAssessment(wallet, evidence, coverage, {
    latencyMs: now() - startedAt,
  });
  assessment.chain = chain;
  assessment.chain_id = chainConfig.chainId;
  return assessment;
}

/**
 * Runs a full wallet assessment under the standard RPC budget and hard
 * cutoff, and never throws: any failure comes back as an UNAVAILABLE
 * assessment object instead. Exported so other routes (notably
 * /fraud-query, which receives wallet questions phrased as prose) can
 * reuse the real analysis path rather than reimplementing the budget and
 * error handling around it.
 *
 * @param {string} wallet
 * @returns {Promise<import('../core/assessment/model.js').Assessment>}
 */
export async function assessWalletSafely(wallet) {
  try {
    return await withRpcBudget(config.hardCutoffMs, () => runFastAssessment(wallet));
  } catch (err) {
    const unavailable = err instanceof ApiKeyMissingError || err instanceof RpcBudgetExceededError;
    return makeUnavailableAssessment(wallet, unavailable ? err.message : 'RPC analysis failed');
  }
}

async function handleAssessWallet(req, res) {
  const wallet = req.method === 'GET' ? req.query?.wallet : req.body?.wallet;
  const requestedChain = req.method === 'GET' ? req.query?.chain : req.body?.chain;
  const chain = normalizeChain(requestedChain);

  if (!wallet || !isAddress(wallet)) {
    return res.status(400).json({
      error:
        req.method === 'GET'
          ? 'must include a valid `wallet` query parameter'
          : 'body must include a valid `wallet` address',
    });
  }
  if (!chain) {
    return res.status(400).json({ error: `chain must be one of: ${SUPPORTED_CHAIN_KEYS.join(', ')}` });
  }

  try {
    return res.json(await runFastAssessment(wallet, { chain }));
  } catch (err) {
    const unavailable = err instanceof ApiKeyMissingError || err instanceof RpcBudgetExceededError;
    const assessment = makeUnavailableAssessment(wallet, unavailable ? err.message : 'RPC analysis failed');
    assessment.chain = chain;
    assessment.chain_id = getChainConfig(chain).chainId;
    return res.status(503).json(assessment);
  }
}

export async function handleWithBudget(req, res) {
  const wallet = req.method === 'GET' ? req.query?.wallet : req.body?.wallet;
  try {
    await withRpcBudget(config.hardCutoffMs, () => handleAssessWallet(req, res));
  } catch (err) {
    if (!res.headersSent) {
      const requestedChain = req.method === 'GET' ? req.query?.chain : req.body?.chain;
      const chain = normalizeChain(requestedChain) ?? 'eth';
      const assessment = makeUnavailableAssessment(wallet ?? '', err instanceof RpcBudgetExceededError ? err.message : 'RPC analysis failed');
      assessment.chain = chain;
      assessment.chain_id = getChainConfig(chain).chainId;
      return res.status(503).json(assessment);
    }
  }
}

router.get('/', handleWithBudget);
router.post('/', handleWithBudget);

export default router;
