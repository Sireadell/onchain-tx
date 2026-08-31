// WEB_SEARCH signal endpoint. Answers an open question from a live web
// search (lib/webSearch.js, Tavily) rather than from a single structured
// provider. Query param: query (required, also accepted as q/question/
// search/topic). Optional: max_results (1-20, default 5), topic
// (general/news/finance).
//
// This route deliberately has no intent guard, which every other free-text
// route here does have. The guards exist because a stray word must not turn
// a drug question into a storm forecast. WEB_SEARCH has no such boundary to
// defend: any question at all is a legitimate web search, so a cue list
// could only ever refuse questions we can answer.

import { Router } from 'express';
import { searchWeb, hasWebSearchProvider, WebSearchError } from '../lib/webSearch.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';

const router = Router();

// Tavily indexes news and finance separately from its general crawl, and
// picking the right one materially changes what comes back for a question
// about today's events or a market move. Read from the question because the
// dispatcher forwards prose, not parameters.
const NEWS_CUES = /\b(?:news|headlines?|breaking|latest|today|yesterday|this\s+(?:week|morning)|announced|reported|just\s+happened|current\s+events)\b/i;
const FINANCE_CUES = /\b(?:earnings|revenue|market\s+cap|stock\s+market|IPO|dividend|quarterly|guidance|analyst|investors?|valuation|funding\s+round)\b/i;

function inferTopic(text) {
  if (FINANCE_CUES.test(text)) return 'finance';
  if (NEWS_CUES.test(text)) return 'news';
  return 'general';
}

// A search engine wants the question as the person asked it, so unlike
// /academic-search this route does not strip question framing. The one
// thing worth removing is a leading "search the web for" / "look up"
// instruction aimed at the miner rather than at the search index.
function cleanQuery(raw) {
  const stripped = String(raw)
    .replace(/^\s*(?:please\s+)?(?:search\s+(?:the\s+)?(?:web|internet|online)\s+(?:for|about)?|look\s+up|google|web\s*search\s+(?:for)?)\s+/i, '')
    .trim();
  return stripped || String(raw).trim();
}

async function handleWebSearch(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawQuery = params?.query ?? params?.q ?? params?.question ?? params?.search ?? params?.topic;

  if (!rawQuery || !String(rawQuery).trim()) {
    return respondUnusableInput(
      res,
      'I cannot run a web search because no question was supplied. Pass the question as the query parameter and I will answer it from live web sources, with the sources named.',
    );
  }

  // A provider outage is our fault and keeps a real failure code, but a
  // missing key is a deployment mistake that would otherwise show up as a
  // silent stream of 502s. Named separately so it is obvious in the logs.
  if (!hasWebSearchProvider()) {
    return res.status(503).json({
      status: 'error',
      summary: 'Web search is not configured on this deployment.',
      confidence: 0,
      error: 'neither PERPLEXITY_API_KEY nor TAVILY_API_KEY is set',
    });
  }

  const explicitMax = params?.max_results != null ? Number(params.max_results) : null;
  const maxResults = Number.isFinite(explicitMax) && explicitMax > 0 ? Math.min(explicitMax, 20) : 5;
  const searchQuery = cleanQuery(rawQuery);
  const topic = params?.topic_mode ?? inferTopic(String(rawQuery));

  let result;
  try {
    result = await searchWeb(searchQuery, { topic, maxResults });
  } catch (err) {
    if (err instanceof WebSearchError) {
      return res.status(502).json({
        status: 'error',
        summary: `Web sources are temporarily unavailable for ${quoteParam(rawQuery)}. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    return res.status(502).json({ status: 'error', summary: 'web search failed', confidence: 0, error: err.message });
  }

  // Only a search that produced no answer at all is reported as nothing
  // matched. A provider that wrote an answer but listed no sources still
  // answered the question, and discarding that for having an empty source
  // list would throw away a scoring answer over presentation.
  if (!result.answer) {
    return respondUnusableInput(
      res,
      `No web sources matched ${quoteParam(rawQuery)}. Try rephrasing the question with more specific wording.`,
    );
  }

  // The graded field leads with the answer itself and carries only a short
  // source note after it. The temptation is to list every result the way
  // /academic-search does, but that route lists papers because the papers
  // ARE the answer there. Here the answer is a fact, and padding it with
  // link text pushes the wording away from the ground-truth sentence the
  // engine compares against. Three sources named, no snippets.
  const cited = result.results.slice(0, 3)
    .map((r) => `${r.title}${r.url ? ` (${r.url})` : ''}`)
    .join('; ');

  const sourceNote = result.results.length
    ? `Answered from a live web search at request time, drawing on ${result.results.length} ${result.results.length === 1 ? 'source' : 'sources'}, the most relevant being: ${cited}.`
    : 'Answered from a live web search at request time.';

  const summary = [result.answer, sourceNote].join(' ');

  res.json({
    query: rawQuery,
    status: 'ok',
    summary,
    // Reported below 1.0 because a synthesized web answer is only as
    // reliable as the pages behind it, unlike a chain read or a live TLS
    // handshake where the value either is or is not what the source says.
    confidence: 0.9,
    canonical: ['web-search', searchQuery, result.results[0]?.url ?? ''].join(':'),
    search_query: searchQuery,
    topic: result.topic,
    result_count: result.results.length,
    sources: result.results,
    provider: result.provider,
    // Only Perplexity reports a per-question price. Surfaced so the running
    // cost of this intent is visible in the logs rather than only on a bill.
    cost_usd: result.cost_usd ?? null,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleWebSearch(req, res));
router.post('/', (req, res) => handleWebSearch(req, res));

export default router;
