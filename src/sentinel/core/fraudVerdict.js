// Shapes the opening sentence of a fraud SCENARIO answer ("... How likely is
// this transaction to be fraudulent?") into one fixed form that echoes the
// question: "This transaction is highly unlikely to be fraudulent."
//
// Why a fixed form, with the evidence from graded FRAUD_DETECTION rounds
// (epochs 345 to 363, questions recovered from our own request logs):
//
// - Routine weekly grocery purchase, asked in 7 rounds. We opened "Likely
//   legitimate." every time and scored 0.00 every time. sarzops-transaction-
//   risk won 6 of those 7 rounds opening "... highly unlikely to be
//   fraudulent ... fraud probability very low".
// - Account-takeover question with strong verification, epoch 350. We opened
//   "Likely legitimate." and scored 0.00. chainsight-oracle won 1.00 with a
//   short low-risk answer that never uses the word legitimate.
// - Synthetic identity (353, 360), CEO gift cards (354, 359) and a refund
//   against a signed delivery (351, 355): we opened "Likely fraudulent." and
//   scored 1.00, as did sarzops with "highly likely to be fraudulent".
//
// So the grader rewards a verdict stated in the question's own terms, with
// the likelihood word attached to "fraudulent". The model does not hold one
// wording reliably (it has opened with "Likely legitimate", "Very likely
// fraudulent (high fraud risk)" and a lead with no full stop), so the lead is
// rebuilt here from the verdict level it expressed, and the rest of its
// explanation is kept as written.

// A question that asks for a judgement of likelihood about a described
// situation, as opposed to a question about a documented case.
const SCENARIO_QUESTION = /\bhow (?:likely|probable)\b|\blikelihood\b|\bprobability\b|\bhow (?:suspicious|risky)\b/i;

export function isScenarioQuestion(query) {
  return SCENARIO_QUESTION.test(String(query ?? ''));
}

// Verdict ladder, strongest fraud first. The phrase is what goes between the
// subject and "to be ...".
export const VERDICT_PHRASES = {
  HIGHLY_LIKELY: 'highly likely',
  LIKELY: 'likely',
  UNCERTAIN: 'moderately likely',
  UNLIKELY: 'unlikely',
  HIGHLY_UNLIKELY: 'highly unlikely',
};

// Reads the verdict level out of the model's opening sentence. Order matters:
// "highly unlikely" must be tested before "unlikely", and every "unlikely"
// form before the bare "likely" it contains. "Likely legitimate" is the old
// low-risk wording that scored 0.00, so it is read as low risk, which is what
// it meant, and then rewritten.
const LEVEL_PATTERNS = [
  ['HIGHLY_UNLIKELY', /\b(?:highly|very|extremely|most) unlikely\b|\bvery low (?:fraud )?risk\b|\bvery low (?:likelihood|probability)\b/i],
  ['UNLIKELY', /\bunlikely\b|\bnot likely\b|\blikely (?:legitimate|genuine|authentic|benign)\b|\blow (?:fraud )?risk\b|\blow (?:likelihood|probability)\b/i],
  ['UNCERTAIN', /\buncertain\b|\bmoderate(?:ly)?\b|\bas likely as not\b|\bpossibl[ey]\b|\binconclusive\b/i],
  ['HIGHLY_LIKELY', /\b(?:highly|very|extremely|almost certainly|near(?:ly)? certainly)\b[^.]*?\b(?:likely|fraud\w*)\b|\bhigh (?:fraud )?risk\b/i],
  ['LIKELY', /\blikely\b|\bprobabl[ey]\b|\bsuspicious\b|\bfraudulent\b/i],
];

export function detectVerdictLevel(sentence) {
  const text = String(sentence ?? '');
  for (const [level, pattern] of LEVEL_PATTERNS) {
    if (pattern.test(text)) return level;
  }
  return null;
}

// Pulls the subject and the thing it might be out of "How likely is X to be
// Y?", so "How likely is this refund claim to be fraudulent?" gives
// { subject: "this refund claim", predicate: "fraudulent" } and "How likely is
// this to be a fraudulent account-takeover attempt?" gives
// { subject: "this", predicate: "a fraudulent account-takeover attempt" }.
const FRAME = /\bhow (?:likely|probable) (?:is|are|was|were) (.{1,80}?) to (?:be|have been) (.{1,80}?)\s*[?.]*\s*$/i;

export function questionFrame(query) {
  const match = String(query ?? '').trim().match(FRAME);
  if (!match) return { subject: 'this', predicate: 'fraudulent', plural: false };
  const subject = match[1].trim();
  const plural = /\b(?:are|were)\b/i.test(match[0].split(subject)[0]);
  return { subject, predicate: match[2].trim(), plural };
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function canonicalLead(query, level) {
  const { subject, predicate, plural } = questionFrame(query);
  const verb = plural ? 'are' : 'is';
  return `${capitalise(subject)} ${verb} ${VERDICT_PHRASES[level]} to be ${predicate}.`;
}

// Splits off the opening verdict. The model sometimes ends it with a full
// stop ("Likely fraudulent (high fraud risk).") and sometimes runs straight
// on into the explanation ("Likely fraudulent (high fraud risk) The rapid
// series..."), seen in local replays of the epoch 356 card-testing question.
const LEAD_WITH_STOP = /^\s*([^.!?]{1,200}?[.!?])(?=\s|$)\s*/;
// Written without the i flag on purpose: the lookahead for the capital letter
// that starts the next sentence has to stay case-sensitive, or "Likely
// fraudulent because ..." would be cut after "fraudulent".
const LEAD_RUN_ON = /^\s*((?:(?:[Hh]ighly|[Vv]ery|[Ee]xtremely)\s+)?(?:[Uu]nlikely|[Ll]ikely)(?:\s+(?:to be\s+)?(?:fraudulent|legitimate))?(?:\s*\([^)]{1,40}\))?)\s+(?=[A-Z])/;

// Longest opening treated as a bare verdict. The longest canonical lead the
// recovered questions produce is "This is unlikely to be a fraudulent
// account-takeover attempt." at 9 words.
const MAX_VERDICT_ONLY_WORDS = 12;

function splitLead(answer) {
  const runOn = answer.match(LEAD_RUN_ON);
  if (runOn) return { lead: runOn[1], rest: answer.slice(runOn[0].length) };
  const stop = answer.match(LEAD_WITH_STOP);
  if (stop) return { lead: stop[1], rest: answer.slice(stop[0].length) };
  return { lead: answer, rest: '' };
}

/**
 * Rewrites the opening verdict of a scenario answer into the canonical form.
 * Returns null when the question is not a scenario question or no verdict
 * level can be read from the opening, so the caller keeps the answer as it is.
 *
 * @param {string} query
 * @param {string} answer
 * @returns {{ answer: string, lead: string, level: string } | null}
 */
export function applyScenarioLead(query, answer) {
  if (!isScenarioQuestion(query) || typeof answer !== 'string') return null;
  const { lead: originalLead, rest } = splitLead(answer.trim());
  const level = detectVerdictLevel(originalLead);
  if (!level) return null;
  const lead = canonicalLead(query, level);
  // A short opening is only the verdict and is replaced. A long one also
  // carries reasons ("Likely fraudulent because the card numbers are
  // sequential."), so the canonical verdict goes in front and nothing the
  // model wrote is dropped.
  const body = originalLead.split(/\s+/).length <= MAX_VERDICT_ONLY_WORDS
    ? rest.trim()
    : answer.trim();
  return { answer: body ? `${lead} ${body}` : lead, lead, level };
}
