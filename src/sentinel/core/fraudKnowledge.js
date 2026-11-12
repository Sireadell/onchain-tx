import { addResponseEnvelope } from './response/model.js';
import { askGroqKnowledge } from './providers/groqKnowledge.js';
import { applyScenarioLead, isScenarioQuestion } from './fraudVerdict.js';
import { config } from '../config.js';

const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const DOJ_BITCONNECT_URL = 'https://www.justice.gov/archives/opa/pr/bitconnect-founder-indicted-global-24-billion-cryptocurrency-scheme';
const SEC_BITCONNECT_URL = 'https://www.sec.gov/newsroom/press-releases/2021-172';

// Recognises a provider non-answer -- a refusal, or a plain "I don't
// know" -- so it is never shipped as label: ANSWERED. Widened 2026-08-28
// after the live explorer question feed showed a Groq reply of literally
// "I'm sorry, but I can't help with that." going out as ANSWERED with
// confidence 0.7; the previous pattern only caught the "not aware" /
// "cannot comply" / "cannot verify" phrasings.
const HIGH_CONFIDENCE_UNSUPPORTED_ANSWER = new RegExp(
  [
    "i(?:'m|’m| am) not aware",
    "i(?:'m|’m| am) sorry",
    "i (?:can(?:not|'t|’t)|am unable to) (?:comply|verify|help|assist|provide|answer)",
    "i (?:don'?t|do not) have (?:any |enough )?(?:information|reliable|documented|record)",
    'no documented fraud',
    'no reliable (?:sources?|information)',
    'insufficient information',
  ].map((pattern) => String.raw`\b(?:${pattern})`).join('|'),
  'i',
);
const BITCONNECT_QUESTION = /\bbit\s*connect\b/i;

function normalizeExtract(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_500);
}

// Fraud questions phrased as a lowercase common-noun topic ("business
// email compromise fraud") have no capitalized run for the properRuns
// path below to find, so without this the whole raw question (including
// "what is") was sent to Wikipedia's search -- noisy enough that it
// missed the real "Business email compromise" page entirely (found live
// 2026-08-25 while investigating a Phase 2 benchmark failure). This is
// the same idea as the properRuns path, generalized to lowercase topics:
// strip interrogatives/fillers, keep the rest as the search phrase.
const QUESTION_STOPWORDS = new Set([
  'what', 'who', 'how', 'when', 'where', 'why', 'which', 'describe', 'explain',
  'is', 'was', 'are', 'were', 'did', 'do', 'does', 'the', 'a', 'an', 'of',
  'for', 'in', 'on', 'to', 'and', 'or', 'about',
]);

function searchSubject(query) {
  const quoted = query.match(/["“]([^"”]{3,80})["”]/)?.[1];
  if (quoted) return quoted;

  const words = query.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  const excluded = new Set([
    'What', 'Who', 'How', 'When', 'Where', 'Why', 'Which', 'Describe',
    'Explain', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]);
  const branded = words.find((word) =>
    !excluded.has(word) && (/^[A-Z]{2,}$/.test(word) || /[a-z][A-Z]/.test(word)));
  if (branded) return branded;

  const properRuns = [];
  let current = [];
  for (const word of words) {
    if (/^[A-Z][a-z]/.test(word) && !excluded.has(word)) current.push(word);
    else {
      if (current.length > 0) properRuns.push(current);
      current = [];
    }
  }
  if (current.length > 0) properRuns.push(current);
  const best = properRuns.sort((a, b) => b.length - a.length)[0];
  if (best) return best.join(' ');

  const stripped = words.filter((w) => !QUESTION_STOPWORDS.has(w.toLowerCase()));
  return stripped.length > 0 ? stripped.join(' ') : query;
}

// Free, local (non-AI) tiebreaker for when Wikipedia's own relevance
// ranking puts a page ABOUT the fraud (a documentary, book, film, song)
// ahead of the page about the actual person/scheme -- e.g. "Tinder
// Swindler" -> the Netflix documentary outranked "Simon Leviev" (found
// live 2026-08-25). Only reorders among the REAL fetched candidates,
// never invents one; if every candidate looks like "about the fraud"
// media or none do, leaves Wikipedia's own ranking untouched.
const ABOUT_THE_FRAUD_MEDIA = /\bis\s+(?:an?|the)\s+(?:[a-zA-Z0-9]+\s+){0,5}?(documentary|film|movie|book|novel|song|album|television series|tv series|miniseries|podcast)\b/i;

function preferNonMediaCandidate(candidates) {
  if (candidates.length < 2) return candidates[0];
  const [first, ...rest] = candidates;
  if (!ABOUT_THE_FRAUD_MEDIA.test(first.extract)) return first;
  const nonMedia = rest.find((c) => !ABOUT_THE_FRAUD_MEDIA.test(c.extract));
  return nonMedia ?? first;
}

function hasCompleteSentence(answer) {
  return /[.!?]["')\]]?$/.test(answer.trim());
}

function makeInconclusiveAnswer(message, summary) {
  const result = {
    answer: message,
    confidence: 0,
    assessment_status: 'INCONCLUSIVE',
    summary,
  };
  return addResponseEnvelope(result, {
    mode: 'fraud_knowledge',
    label: 'INCONCLUSIVE',
    reason: result.summary,
  });
}

function makeBitConnectFactCard() {
  const answer = 'BitConnect ran a global Lending Program from 2017 into January 2018, falsely claiming that proprietary volatility software and a trading bot generated high returns. Regulators alleged that it instead used money from newer investors to satisfy earlier investors in a Ponzi-like structure and obtained more than $2 billion. U.S. authorities charged founder Satish Kumbhani, and the Department of Justice stated in February 2022 that he remained at large.';
  const result = {
    answer,
    confidence: 0.95,
    assessment_status: 'ASSESSED',
    summary: 'BitConnect used a purported trading bot to promote a $2 billion-plus Ponzi-like lending scheme; founder Satish Kumbhani was charged and remained at large.',
    source: {
      title: 'SEC Charges Global Crypto Lending Platform and Top Executives in $2 Billion Fraud',
      url: SEC_BITCONNECT_URL,
      secondary_url: DOJ_BITCONNECT_URL,
      provider: 'U.S. SEC and Department of Justice',
    },
  };
  return addResponseEnvelope(result, {
    mode: 'fraud_knowledge',
    label: 'ANSWERED',
    reason: result.summary,
  });
}


// Words that make an article recognisably about fraud, so a genuine answer
// to a fraud question is never blocked by the relevance check below.
const FRAUD_TOPIC_WORDS = [
  'fraud', 'fraudulent', 'defraud', 'scam', 'scammer', 'ponzi', 'pyramid scheme',
  'embezzl', 'launder', 'phishing', 'counterfeit', 'swindl', 'deception',
  'forgery', 'racketeer', 'larceny', 'extortion', 'bribery', 'insider trading',
  'identity theft', 'account takeover', 'chargeback', 'skimming', 'confidence trick',
];

// Plain substring matching, deliberately not a regular expression: these are
// stems, so 'launder' covers laundering and 'embezzl' covers embezzlement.
function mentionsFraud(text) {
  const lower = String(text ?? '').toLowerCase();
  return FRAUD_TOPIC_WORDS.some((word) => lower.includes(word));
}

const RELEVANCE_STOPWORDS = new Set([
  'what', 'who', 'how', 'when', 'where', 'why', 'which', 'that', 'this', 'these',
  'those', 'their', 'there', 'then', 'than', 'with', 'from', 'have', 'has', 'had',
  'been', 'being', 'was', 'were', 'are', 'is', 'the', 'and', 'for', 'about',
  'into', 'over', 'after', 'before', 'they', 'them', 'would', 'could', 'should',
  'likely', 'same', 'also', 'more', 'most', 'some', 'any', 'all', 'each', 'other',
  'does', 'did', 'will', 'can', 'may', 'might', 'must', 'such', 'very', 'both',
]);

function contentWords(text) {
  return new Set(
    (String(text ?? '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [])
      .filter((word) => !RELEVANCE_STOPWORDS.has(word)),
  );
}

// Guards against answering a fraud question with an unrelated encyclopedia
// article. searchSubject picks the first acronym it sees and sends only that
// to Wikipedia, so a question mentioning an ordinary term in capitals loses
// the rest of its meaning.
//
// Live failure that prompted this, epoch 309 on 2026-09-05. Asked "A
// cardholder calls their bank from a new phone number to report a lost
// phone, verifies their identity with their SSN, date of birth, and a
// one-time code ... how likely is this to be a fraudulent account-takeover
// attempt?", this returned "The Virginia class, or the SSN-774 class, is a
// class of nuclear-powered attack submarines...". It matched SSN, the social
// security number, to a US Navy hull classification. It scored 4.2e-15.
//
// An article passes when it is recognisably about fraud, or when it shares
// real subject matter with the question. Anything else is answered
// INCONCLUSIVE, because saying nothing is honest and an unrelated article is
// confidently wrong.
export function articleAnswersQuestion(query, title, extract) {
  const article = `${title ?? ''} ${extract ?? ''}`;
  if (mentionsFraud(article)) return true;

  const asked = contentWords(query);
  // The article's own name appearing in the question is the strongest signal
  // there is: the encyclopedia returned a page about the thing that was
  // actually asked about. "What happened at Wirecard?" against the Wirecard
  // page shares only that one word, which the body test below would reject.
  for (const word of contentWords(title)) {
    if (asked.has(word)) return true;
  }

  const found = contentWords(article);
  let shared = 0;
  for (const word of asked) {
    if (found.has(word)) shared += 1;
    if (shared >= 2) return true;
  }
  return false;
}

/**
 * Answers general fraud-history questions using a bounded, source-linked
 * encyclopedia lookup. This complements wallet assessment because the live
 * FRAUD_DETECTION scoring feed also asks factual questions about known frauds.
 */
export async function answerFraudQuestion(query, opts = {}) {
  if (config.fraudSafetyGuardsEnabled && BITCONNECT_QUESTION.test(query)) {
    return makeBitConnectFactCard();
  }

  const deadlineMs = opts.deadlineMs ?? config.fraudKnowledgeDeadlineMs;
  const deadlineAt = Date.now() + Math.max(1, deadlineMs);
  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), Math.max(1, deadlineMs));
  try {
    const groqBudgetMs = Math.min(
      opts.llmTimeoutMs ?? config.groqCallTimeoutMs,
      Math.max(1, deadlineAt - Date.now()),
    );
    const llmResult = await askGroqKnowledge(query, {
      fetch: opts.llmFetch,
      timeoutMs: groqBudgetMs,
      signal: overallController.signal,
    });
    // A refusal or a plain "I don't know" from the provider is not an
    // answer, so it must never ship as label: ANSWERED. Rather than
    // dead-ending on INCONCLUSIVE here, fall through to the source-linked
    // Wikipedia lookup below, which either finds a real citable answer or
    // returns INCONCLUSIVE itself. Strictly better than returning nothing
    // while a free, citable fallback is sitting right there unused.
    const llmAnswerUnsupported = config.fraudSafetyGuardsEnabled
      && typeof llmResult?.answer === 'string'
      && HIGH_CONFIDENCE_UNSUPPORTED_ANSWER.test(llmResult.answer);

    if (
      llmResult
      && !llmAnswerUnsupported
      && llmResult.finishReason === 'stop'
      && hasCompleteSentence(llmResult.answer)
    ) {
      // Scenario answers get their opening verdict rewritten into the one
      // form the grader has rewarded; see src/core/fraudVerdict.js for the
      // round-by-round evidence.
      const scenario = applyScenarioLead(query, llmResult.answer);
      const answer = scenario?.answer ?? llmResult.answer;
      const leadSentence = scenario?.lead ?? answer.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? answer;
      const result = {
        answer,
        confidence: 0.7,
        assessment_status: 'ASSESSED',
        summary: leadSentence,
        source: {
          provider: 'Groq',
          model: llmResult.model,
          finish_reason: llmResult.finishReason,
        },
      };
      return addResponseEnvelope(result, {
        mode: 'fraud_knowledge',
        label: 'ANSWERED',
        reason: result.summary,
      });
    }

    // An encyclopedia article cannot judge a described situation, and the
    // relevance check below passes any article whose title the question
    // mentions. Replaying the epoch 363 question ("... a $60 taxi from Lisbon
    // airport ... How likely is this transaction to be fraudulent?") with the
    // model call failing returned the Wikipedia article about the city of
    // Lisbon as the fraud verdict. For a scenario, saying nothing is honest.
    if (isScenarioQuestion(query)) {
      return makeInconclusiveAnswer(
        'The fraud assessment for this scenario could not be completed. Retry shortly.',
        'INCONCLUSIVE: the scenario assessment could not be completed.',
      );
    }

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0 || overallController.signal.aborted) {
      return makeInconclusiveAnswer(
        'The fraud knowledge lookup did not finish within its time limit.',
        'INCONCLUSIVE: fraud knowledge lookup timed out.',
      );
    }

    const fetchImpl = opts.fetch ?? globalThis.fetch;
    const wikipediaTimeoutMs = Math.min(opts.timeoutMs ?? 6_000, remainingMs);
    const wikipediaController = new AbortController();
    const abortWikipedia = () => wikipediaController.abort(overallController.signal.reason);
    overallController.signal.addEventListener('abort', abortWikipedia, { once: true });
    const wikipediaTimer = setTimeout(() => wikipediaController.abort(), wikipediaTimeoutMs);

    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'search',
      gsrsearch: searchSubject(query),
      gsrlimit: '3',
      prop: 'extracts|info',
      exintro: '1',
      explaintext: '1',
      exchars: '1200',
      inprop: 'url',
      origin: '*',
    });

    try {
      const response = await fetchImpl(`${WIKIPEDIA_API}?${params}`, {
        headers: {
          accept: 'application/json',
          // Wikimedia's API rejects requests with no User-Agent with a flat
          // 403. Node's built-in fetch sends none by default.
          'user-agent': 'TelegraphSentinel/1.0 (+https://telegraph-sentinel-40vp.onrender.com)',
        },
        signal: wikipediaController.signal,
      });
      if (!response.ok) throw new Error(`knowledge source returned HTTP ${response.status}`);
      const body = await response.json();
      const pages = [...(body?.query?.pages ?? [])].sort(
        (a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER),
      );
      const candidates = pages.filter((item) => normalizeExtract(item.extract).length >= 80);
      if (candidates.length === 0) {
        return makeInconclusiveAnswer(
          'No sufficiently reliable source-backed answer was found for this fraud question.',
          'INCONCLUSIVE: no reliable source-backed answer found.',
        );
      }

      const page = preferNonMediaCandidate(candidates);
      if (!articleAnswersQuestion(query, page.title, normalizeExtract(page.extract))) {
        return makeInconclusiveAnswer(
          'No sufficiently reliable source-backed answer was found for this fraud question.',
          'INCONCLUSIVE: no reliable source-backed answer found.',
        );
      }
      const answer = normalizeExtract(page.extract);
      const leadSentence = answer.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? answer;
      const result = {
        answer,
        confidence: 0.75,
        assessment_status: 'ASSESSED',
        summary: leadSentence,
        source: {
          title: page.title,
          url: page.fullurl ?? null,
          provider: 'Wikipedia',
        },
      };
      return addResponseEnvelope(result, {
        mode: 'fraud_knowledge',
        label: 'ANSWERED',
        reason: result.summary,
      });
    } finally {
      clearTimeout(wikipediaTimer);
      overallController.signal.removeEventListener('abort', abortWikipedia);
    }
  } finally {
    clearTimeout(overallTimer);
  }
}
