// Assessment (public output) data model, see docs/LOCKED_SPEC.md
// "Public risk output" section. This is the top-level shape returned by
// the /assess-wallet route.

import { addResponseEnvelope } from '../response/model.js';

/** @typedef {'LOW' | 'ELEVATED' | 'HIGH' | 'NOT_APPLICABLE'} RiskLevel */
/** @typedef {'ASSESSED' | 'LIMITED' | 'INCONCLUSIVE'} AssessmentStatus */

/**
 * @typedef {Object} Assessment
 * @property {string} wallet
 * @property {number} risk_score - 0.0 - 1.0
 * @property {RiskLevel} risk_level
 * @property {number} confidence - 0.0 - 1.0, independent axis from riskScore
 * @property {AssessmentStatus} assessment_status
 * @property {string[]} reason_codes
 * @property {string} explanation - human-readable; see docs/EVALUATOR_NOTES.md,
 *   this is very likely the field Track 2 extraction reads from
 * @property {import('../evidence/model.js').EvidenceItem[]} evidence
 * @property {Object.<string, { status: 'complete' | 'partial' | 'skipped', reason?: string }>} coverage
 * @property {number} latency_ms
 * @property {'fast' | 'deep'} analysis_tier
 * @property {'wallet_risk'} mode
 * @property {RiskLevel} label - alias of risk_level for the shared Telegraph mapping
 * @property {string} reason - alias of summary for the shared Telegraph mapping (kept
 *   short rather than repeating the full explanation verbatim, see fraudKnowledge.js)
 */

/**
 * @param {Partial<Assessment> & Pick<Assessment, 'wallet' | 'risk_score' | 'risk_level' | 'confidence' | 'assessment_status' | 'explanation'>} fields
 * @returns {Assessment}
 */
export function makeAssessment(fields) {
  const assessment = {
    reason_codes: [],
    evidence: [],
    coverage: {},
    analysis_tier: 'fast',
    latency_ms: 0,
    ...fields,
  };

  // The live FRAUD_DETECTION traffic asks for the verdict in two forms at
  // once: "Return probability 0 to 1 and a % risk." (measured verbatim on
  // the engine's question feed, 2026-08-30). risk_score already answers the
  // first half; without this the second half went unanswered entirely, in
  // both the structured fields and the summary text a grader reads.
  if (Number.isFinite(assessment.risk_score)) {
    assessment.risk_pct = Math.round(assessment.risk_score * 100);
    if (typeof assessment.summary === 'string') {
      assessment.summary = `${assessment.summary} Probability ${assessment.risk_score} (${assessment.risk_pct}% risk).`;
    }
  }

  return addResponseEnvelope(assessment, {
    mode: 'wallet_risk',
    label: assessment.risk_level,
    // Falls back to explanation if a caller ever omits summary, so reason
    // (a required string in miner.yaml's output_schema) is never undefined.
    reason: assessment.summary ?? assessment.explanation,
  });
}

/**
 * A response for when analysis could not produce a usable assessment at
 * all (e.g. RPC layer unavailable), distinct from INCONCLUSIVE, which
 * means "we looked, evidence was insufficient." This means "we didn't
 * get to look."
 */
export function makeUnavailableAssessment(wallet, reason) {
  const explanation = `Assessment unavailable: ${reason}`;
  const summary = `UNAVAILABLE: assessment could not be completed (${reason}).`;
  return addResponseEnvelope({
    wallet,
    confidence: 0,
    assessment_status: 'INCONCLUSIVE',
    explanation,
    summary,
    reason_codes: ['ASSESSMENT_UNAVAILABLE'],
    evidence: [],
    coverage: {},
    analysis_tier: 'fast',
    latency_ms: 0,
  }, {
    mode: 'wallet_risk',
    label: 'INCONCLUSIVE',
    reason: summary,
  });
}

/**
 * A response for when the subject address itself isn't a standard funded
 * wallet -- a burn/null address or a known pooling/mixer contract -- so
 * normal funding-relationship risk scoring doesn't apply. Distinct from
 * both ASSESSED (we scored it) and the other INCONCLUSIVE case above (we
 * couldn't get data): here we got a clear answer, and the answer is "the
 * question doesn't apply to this address." risk_level is NOT_APPLICABLE,
 * never LOW -- LOW would misleadingly imply funding-relationship risk was
 * evaluated and came back clean, which never happened for these subjects.
 *
 * @param {string} wallet
 * @param {import('../evidence/model.js').EvidenceItem} evidence
 * @param {{ latencyMs?: number }} [opts]
 * @returns {Assessment}
 */
export function makeNotApplicableAssessment(wallet, evidence, opts = {}) {
  return makeAssessment({
    wallet,
    risk_score: 0,
    risk_level: 'NOT_APPLICABLE',
    confidence: 0.95,
    assessment_status: 'INCONCLUSIVE',
    explanation: evidence.note,
    summary: 'NOT_APPLICABLE: this address is not a standard funded wallet (burn/null or known mixer).',
    reason_codes: ['SUBJECT_NOT_STANDARD_WALLET'],
    evidence: [evidence],
    coverage: {
      subject_applicability: { status: 'complete' },
    },
    latency_ms: opts.latencyMs ?? 0,
  });
}

/**
 * A response for when the assessed address is itself a publicly
 * identified exchange or bridge address. Distinct from
 * makeNotApplicableAssessment: there the honest answer is "this question
 * doesn't apply"; here we have a positive, confident identification of
 * what the address is, so this is a real ASSESSED verdict of LOW.
 *
 * Deliberately not risk_level NOT_APPLICABLE. A user asking "is Binance
 * 14 a scam wallet?" is owed the actual answer -- it is a named exchange
 * wallet -- not a shrug. Confidence is high but short of certainty, and
 * the explanation states plainly that naming the operator is not a clean
 * bill of health for the individual funds moving through it.
 *
 * @param {string} wallet
 * @param {import('../evidence/model.js').EvidenceItem} evidence
 * @param {{ latencyMs?: number }} [opts]
 * @returns {Assessment}
 */
export function makeKnownEntityAssessment(wallet, evidence, opts = {}) {
  const isExchange = evidence.entityClassification === 'known_exchange';
  return makeAssessment({
    wallet,
    risk_score: 0.05,
    risk_level: 'LOW',
    confidence: 0.9,
    assessment_status: 'ASSESSED',
    explanation: evidence.note,
    summary: isExchange
      ? 'LOW: this address is a publicly identified centralized-exchange wallet, not an unattributed one.'
      : 'LOW: this address is a publicly identified cross-chain bridge contract, not an ordinary wallet.',
    reason_codes: [evidence.signalCode],
    evidence: [evidence],
    coverage: {
      subject_entity_identification: { status: 'complete' },
    },
    latency_ms: opts.latencyMs ?? 0,
  });
}
