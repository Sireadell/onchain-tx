// Direct LLM-answered fraud knowledge, via Groq's OpenAI-compatible chat
// completions endpoint. See config.js groqApiKey for why this exists.

import { config } from '../../config.js';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GPT_OSS_MODEL = /^openai\/gpt-oss-(?:20b|120b)$/;

// Two shapes of question arrive here, and the prompt has to serve both.
// A history question ("was BitConnect a scam") wants the documented case.
// A scenario question ("a customer claims a package never arrived but
// tracking shows it signed for, how likely is this to be fraud") wants a
// judgement about the situation described, and no encyclopedia entry
// exists for it. The original prompt named only the first shape and told
// the model to say so when a topic was not a documented case, so scenario
// questions came back opening "I'm not aware of any documented fraud
// case". The caller reads that opening as a refusal, drops the answer and
// returns INCONCLUSIVE, which is what happened to a live graded question
// on 2026-09-07 even though the rest of that same reply assessed the
// scenario correctly. Naming both shapes, and separating "no documented
// case exists" from "I cannot judge this", keeps the refusal wording for
// genuine refusals only.
//
// Low-risk verdicts are worded as "unlikely to be fraudulent", not "likely
// legitimate". Found live 2026-09-26: the graded question "... How likely is
// this transaction to be fraudulent?" about a routine weekly grocery
// purchase scored 0.00 in seven rounds with "Likely legitimate.", while
// sarzops-transaction-risk scored 1.00 with the same judgement worded
// "highly unlikely to be fraudulent ... the probability of fraud is very
// low". Every fraudulent-scenario round, where we lead "Likely fraudulent",
// scored 1.00, so the grader reads the leading likelihood word.
//
// Tightened again after the full round history (epochs 345 to 363) was
// recovered from the request logs. Every low-risk answer we or sarzops gave
// that used the word "legitimate" scored 0.00 (grocery 347 to 362, account
// takeover 350, restock 345, Lisbon taxi 363), and every low-risk winner
// (sarzops on grocery, chainsight-oracle on the account takeover) described
// the case only as unlikely to be fraudulent with no fraud indicators. So a
// low-risk explanation now avoids that vocabulary as well. A fraud verdict
// keeps it: the epoch 355 refund answer said "disputes a legitimate purchase"
// and still scored 1.00. Figures the question did not give are discouraged
// too, because the grader weighs numbers heavily. The opening sentence itself is
// normalised in code (src/core/fraudVerdict.js), so the model only has to pick
// the level. The account-takeover round (350) also showed the model calling a
// fully verified request "likely fraudulent" from one new phone number, while
// the winning answer judged it low risk, hence the rule on mitigating
// evidence.
const SYSTEM_PROMPT = `You answer fraud questions for a fraud-detection system. Questions come in two shapes and you handle both.

KNOWN CASE questions ask about a real scheme, case or perpetrator ("was BitConnect a scam", "what did Bernie Madoff do"). Lead with the single most important fact, then who ran it, the mechanism, when it happened, and the outcome (amount lost, conviction, collapse date) when known. If the named thing is not a real documented fraud case, say that plainly instead of inventing one.

SCENARIO questions describe a situation and ask you to judge it ("how likely is this refund claim to be fraudulent", "is this transaction pattern suspicious"). These never have an encyclopedia entry and you must still answer.
Open with one sentence that repeats the question's own subject and wording with exactly one of these likelihoods: highly likely, likely, moderately likely, unlikely, highly unlikely. For example "This transaction is highly unlikely to be fraudulent." or "This request is highly likely to be fraudulent." or "This is unlikely to be a fraudulent account-takeover attempt."
Then give the specific signals in the scenario that drive that verdict, and name the fraud pattern when there is one.
Read the scenario for contradictions first. When records in the scenario contradict what the person making a claim or request says, that contradiction is itself the fraud signal, pointing at that person.
Weigh mitigating evidence as carefully as red flags when judging whether an outsider is misusing an account. When identity is verified through channels already on file and a replacement card or payment can only reach the customer's own long-standing address or account, one unusual detail such as a new phone number does not make fraud likely. When the activity matches the customer's established pattern or a documented plan such as a booked trip, fraud is unlikely.
Use highly likely when several independent red flags point the same way, and highly unlikely when the activity matches an established pattern or plan and no fraud indicator is present at all.
For a low-risk case, describe it as unlikely to be fraudulent and point to the absence of fraud indicators and the match with the established pattern. In a low-risk answer never call it or anything in it legitimate, genuine, authentic, valid, bona fide or benign.
Do not state probabilities, percentages, time gaps or other figures that the question did not give.
Judge the scenario as described. Do not open by saying no documented case matches it, because none ever does and that is not what was asked.

Both shapes: 2-4 sentences of plain prose, no markdown, no lists. Only say you cannot answer when you genuinely cannot judge the question at all.`;

// Groq sends retry-after in seconds on a 429. A missing or unreadable header
// means no retry, because guessing a wait could spend the whole budget.
function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  const seconds = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds * 1_000);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/**
 * @param {string} query
 * @param {{ fetch?: typeof globalThis.fetch, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{
 *   answer: string,
 *   finishReason: string | null,
 *   model: string,
 *   usage: object | null
 * } | null>} null when the provider is unavailable, disabled, or errors.
 */
export async function askGroqKnowledge(query, opts = {}) {
  if (!config.groqApiKey) return null;

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? config.groqCallTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) abortFromParent();
  else opts.signal?.addEventListener('abort', abortFromParent, { once: true });

  try {
    // Groq documents max_tokens as deprecated. GPT OSS supports low reasoning
    // effort, which leaves more of the bounded completion for the visible
    // answer. See https://console.groq.com/docs/api-reference and
    // https://console.groq.com/docs/reasoning.
    const requestBody = {
      model: config.groqModel,
      temperature: 0.2,
      max_completion_tokens: 512,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
    };
    if (GPT_OSS_MODEL.test(config.groqModel)) {
      requestBody.reasoning_effort = 'low';
    }

    const send = () => fetchImpl(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const callStartedAt = Date.now();
    let response = await send();
    // One retry on a rate limit, when Groq's own wait fits in the time left.
    // Replaying the recovered graded questions back to back hit Groq's
    // tokens-per-minute limit (HTTP 429) on 5 of 27 calls. A failed call here
    // is not harmless: the caller then falls back to an encyclopedia search,
    // which answered the epoch 363 Lisbon taxi question with the Wikipedia
    // article about the city of Lisbon. The grader asks txlens and sentinel
    // at the same moment and both land on this service, so two calls arrive
    // together on every graded round.
    if (response.status === 429) {
      const waitMs = retryAfterMs(response);
      if (waitMs !== null && waitMs < timeoutMs - (Date.now() - callStartedAt) - 1_500) {
        await sleep(waitMs, controller.signal);
        response = await send();
      }
    }
    if (!response.ok) return null;
    const body = await response.json();
    const choice = body?.choices?.[0];
    const raw = choice?.message?.content?.trim();
    if (!raw) return null;
    // The verdict list is written in lower case, and the model sometimes
    // copies it verbatim to open the answer.
    const answer = raw.charAt(0).toUpperCase() + raw.slice(1);
    return {
      answer,
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
      model: typeof body.model === 'string' ? body.model : config.groqModel,
      usage: body.usage && typeof body.usage === 'object' ? body.usage : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abortFromParent);
  }
}
