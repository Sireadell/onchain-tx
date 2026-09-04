// The Telegraph engine books any non-2xx response as a failed question: no
// signal recorded, no payment, and a scored miss on the intent. Malformed
// params are routine rather than exceptional here, because the engine reuses
// one entity string across intents, so a bare 400 turns an ordinary mismatch
// into a lost question. Competing miners answer these in prose and get scored.
//
// So caller-input problems answer 200 with a plain sentence saying what the
// endpoint needs. The body keeps the shape declared in miner.yaml's
// signal_mapping (status/summary/confidence) and omits `error`, which is the
// field miner.yaml names as code_path, so the engine reads it as an answer
// rather than a fault.
//
// This applies only to input we can see is unusable. Upstream outages, RPC
// budget exhaustion, and timeouts keep their real failure codes: those are our
// fault, and reporting them as answers would hide genuine downtime.
export const UNUSABLE_INPUT_STATUS = 'invalid_input';

// A refusal used to go out at confidence 1.0, which asserted full certainty
// in a body that contains no answer. miner.yaml names `confidence` as the
// signal_mapping confidence_field, so that number is what any consumer reads
// as "how much should this response be trusted" — and claiming the maximum
// for a non-answer can only ever cost us. Low, not zero: we remain certain
// about the one thing the body does say, which is what the endpoint needs.
//
// Judgment call, not a measured one: Telegraph does not publish how (or
// whether) the scorer weighs confidence, so this is reasoning from what the
// field means rather than from an observed score change. Revisit if a real
// scoring signal ever contradicts it.
export const UNUSABLE_INPUT_CONFIDENCE = 0.1;

export function respondUnusableInput(res, summary, confidence = UNUSABLE_INPUT_CONFIDENCE) {
  return res.status(200).json({
    status: UNUSABLE_INPUT_STATUS,
    summary,
    confidence,
  });
}

const MAX_ECHO_CHARS = 80;

// Echo back what the caller actually sent, so the answer names the problem
// instead of restating the schema. Capped because these params arrive
// unvalidated and an unbounded echo would let a caller dictate our body size.
export function quoteParam(value) {
  const text = String(value);
  return text.length > MAX_ECHO_CHARS ? `"${text.slice(0, MAX_ECHO_CHARS)}..."` : `"${text}"`;
}
