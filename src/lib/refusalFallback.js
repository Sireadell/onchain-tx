// Last-resort answer for questions this miner would otherwise turn away.
//
// A refusal is a scored miss: the engine records invalid_input as an answer
// that did not answer, so the question is lost either way. That makes the
// refusal path the one place where calling a general web model costs nothing
// we still have. If the search answers, we score something instead of
// nothing. If it is slow, empty, or down, the caller gets the refusal it
// would have got anyway.
//
// The one way this CAN be worse than not running is time. Telegraph cuts any
// miner response off at 30s (commit d9d07d7), measured at the dispatcher, so
// it includes the network and any cold start. A route may already spend
// MAX_ANALYSIS_TIME_MS (12s, ankrRpc.js) before it refuses. A search budget
// large enough to stack on top of that would trade a graded near-zero for an
// ungraded timeout, which is strictly worse. Hence the budgets below: a
// Perplexity answer measured 1,880-3,290ms in production on 2026-09-01, so
// 5s keeps the entire measured upside while making the timeout class
// unreachable (12s route + 3s search still lands inside 15s).
//
// Deliberately narrow:
//
//   1. Only `invalid_input` is rescued. Real outages (status `error`, 5xx)
//      keep their failure codes, for the reason unusableInput.js gives: a
//      failure reported as an answer hides genuine downtime.
//   2. The two intents ranked #1 on the network, IP_GEOLOCATION and
//      SSL_VERIFICATION, are excluded outright. They have no upside left to
//      win, and /ip-geolocate in particular answers a genuine ip-api outage
//      with respondUnusableInput (checkIpGeolocation.js), so rescuing it
//      would hide downtime behind a confident-looking guess.
//   3. Refusals that name the caller's own broken input are kept. "0xabc is
//      not a valid wallet address" tells the dispatcher what to send next; a
//      web model asked the same thing can only guess.
//   4. /web-search is skipped, since it already is this search.
//   5. Rescues are capped per hour, because every one spends real money and
//      a drained key would take /web-search down with it.

import { UNUSABLE_INPUT_STATUS } from './unusableInput.js';
import { searchWeb, hasWebSearchProvider } from './webSearch.js';
import { isQuestionLike } from './intentGuard.js';
import { freeTextParam } from './entityExtract.js';
import { extractRequestText } from './misrouteWatch.js';

// Telegraph's hard ceiling is 30s at the dispatcher. Stopping at 15s leaves
// room for the network, a cold start, and sending the body we already hold.
const REQUEST_DEADLINE_MS = 15_000;

// What the search itself may use. The slowest answer measured in production
// was 3,290ms, so this is generous cover rather than a target.
const SEARCH_BUDGET_MS = 5_000;

// The fastest answer measured was 1,880ms. Below this there is no point
// starting: it would only delay a refusal already in hand.
const MIN_USEFUL_MS = 1_500;

// Every rescue is a paid API call on a public URL. Without a ceiling, a
// caller sending question-shaped garbage to all 14 routes could drain the
// key, and a drained key takes the WEB_SEARCH intent down with it.
const MAX_RESCUES_PER_HOUR = 60;

const SKIP_PATHS = new Set([
  '/health',
  // Already this search. Rescuing it would ask Perplexity the same question
  // twice for one request.
  '/web-search',
  // Ranked #1 on the network. Nothing to gain, and both can answer a real
  // provider outage with invalid_input.
  '/ip-geolocate',
  '/ssl-check',
]);

// Express matches routes case-insensitively and tolerates a trailing slash,
// so an exact string match would let /Web-Search/ past the skip list.
function normalisePath(path) {
  return String(path).toLowerCase().replace(/\/+$/, '') || '/';
}

// A refusal that quotes the caller's own value back is naming unusable
// input rather than declining a question, and that reply is more use than a
// guess. quoteParam (unusableInput.js) is what puts the value in quotes.
function namesUnusableInput(summary) {
  return typeof summary === 'string' && /"[^"]*"/.test(summary);
}

const rescueTimes = [];

function withinRescueCap(now, cap) {
  const hourAgo = now - 3_600_000;
  while (rescueTimes.length && rescueTimes[0] < hourAgo) rescueTimes.shift();
  return rescueTimes.length < cap;
}

// Exported for tests; a fresh process starts empty anyway.
export function resetRescueCap() {
  rescueTimes.length = 0;
}

// misrouteWatch's extractor joins every string param, which is right for
// keyword detection and wrong as a search prompt: it would send Perplexity
// "Is 0xdead confirmed? ethereum 0xdead". Prefer the free-text question the
// dispatcher actually wrote, the same way /web-search does.
function searchQuery(req) {
  const params = req.method === 'GET' ? req.query : req.body;
  const freeText = freeTextParam(params);
  if (typeof freeText === 'string' && freeText.trim()) return freeText.trim();
  return extractRequestText(req);
}

function rescuedBody(original, result) {
  const answer = String(result.answer).trim();
  const results = result.results ?? [];
  const cited = results.slice(0, 3)
    .map((r) => `${r.title}${r.url ? ` (${r.url})` : ''}`)
    .join('; ');
  const sourceNote = results.length
    ? `Answered from a live web search at request time, drawing on ${results.length} ${results.length === 1 ? 'source' : 'sources'}, the most relevant being: ${cited}.`
    : 'Answered from a live web search at request time.';
  const summary = [answer, sourceNote].join(' ');

  return {
    ...original,
    status: 'ok',
    summary,
    // Set here rather than left to answerFieldMiddleware, so the graded
    // field is right regardless of where this middleware sits in the chain.
    answer: summary,
    // Same figure /web-search reports, because this is the same answer from
    // the same provider: as reliable as the pages behind it, and no more.
    confidence: 0.9,
    provider: result.provider,
    answered_by_fallback: true,
  };
}

export function createRefusalFallbackMiddleware(options = {}) {
  const search = options.search ?? searchWeb;
  const hasProvider = options.hasProvider ?? hasWebSearchProvider;
  const searchBudgetMs = options.searchBudgetMs ?? SEARCH_BUDGET_MS;
  const deadlineMs = options.deadlineMs ?? REQUEST_DEADLINE_MS;
  const minUsefulMs = options.minUsefulMs ?? MIN_USEFUL_MS;
  const maxPerHour = options.maxRescuesPerHour ?? MAX_RESCUES_PER_HOUR;

  return function refusalFallbackMiddleware(req, res, next) {
    // Captured here, not later: express rewrites req.url when a request
    // enters a mounted router, so by the time res.json runs req.path has
    // already become '/'. The skip check below is the only place it is
    // still the real path.
    const path = normalisePath(req.path);
    if (SKIP_PATHS.has(path)) return next();

    const question = searchQuery(req);
    if (!question || !isQuestionLike(question)) return next();

    const startedAt = Date.now();
    const sendJson = res.json.bind(res);

    // A destroyed socket emits an asynchronous error that a synchronous
    // try/catch around the write cannot see, and express installs no handler
    // of its own. One no-op listener keeps that from reaching the process.
    res.on('error', () => {});

    // Exactly one of these paths may send. A route that refuses and then
    // throws, or a handed-off request that reaches res.json twice, must not
    // produce a second write onto a finished response.
    let forwarded = false;

    res.json = (body) => {
      if (forwarded) {
        console.warn(`[refusal-fallback] suppressed a second response on ${req.originalUrl}`);
        return res;
      }
      const isRefusal = body && typeof body === 'object' && !Array.isArray(body)
        && body.status === UNUSABLE_INPUT_STATUS;
      forwarded = true;
      if (!isRefusal || !hasProvider()) return sendJson(body);
      if (namesUnusableInput(body.summary)) return sendJson(body);

      const now = Date.now();
      if (!withinRescueCap(now, maxPerHour)) {
        console.warn('[refusal-fallback] hourly rescue cap reached, refusing as normal');
        return sendJson(body);
      }

      const budgetMs = Math.min(searchBudgetMs, startedAt + deadlineMs - now);
      if (budgetMs < minUsefulMs) return sendJson(body);

      rescueTimes.push(now);

      // Detached on purpose: express does not await res.json, so the send
      // happens when the search settles. Every path ends in exactly one send
      // attempt, and the trailing catch guarantees no unhandled rejection
      // can take down the single process serving all 14 intents.
      (async () => {
        let finalBody = body;
        let rescued = false;
        try {
          const result = await search(question, { budgetMs });
          if (result && typeof result.answer === 'string' && result.answer.trim()) {
            finalBody = rescuedBody(body, result);
            rescued = true;
          }
        } catch {
          // A search that fails leaves the refusal exactly as it was. The
          // question was already lost; a broken provider must not also turn
          // a clean 200 into a crash.
        }
        console.log(`[refusal-fallback] path=${path} rescued=${rescued} ms=${Date.now() - now} provider=${finalBody.provider ?? 'none'}`);
        if (!res.headersSent && !res.writableEnded && !res.destroyed) sendJson(finalBody);
      })().catch(() => {});

      return res;
    };

    next();
  };
}
