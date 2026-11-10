// WEB_SEARCH backing service. Unlike every other lib in here, this one has
// no single authoritative provider to read a number from: the question can
// be about anything, so the answer is a live search plus the provider's own
// written reply.
//
// Two providers, tried in order, the same shape as the weather chain in
// weatherForecast.js.
//
// 1. Perplexity. Migrated 2026-09-18 from the old Sonar chat/completions
//    contract (verified 2026-08-31) to the Agent API (v1/agent): Sonar
//    chat/completions started rejecting this deployment's account with
//    insufficient_quota, and Perplexity is retiring it entirely on
//    2026-09-27 regardless. Verified live against the real key: POST
//    https://api.perplexity.ai/v1/agent, bearer auth, model
//    `perplexity/sonar`, `tools: [{type: 'web_search'}]` to turn search on
//    (opt-in on this API, unlike Sonar's always-on default), the answer at
//    the last `output` item whose type is `message`
//    (`content.find(c => c.type === 'output_text').text`), and the sources
//    at the `output` item whose type is `search_results`, its own `results`
//    array carrying title/url/snippet, same fields as before under a new
//    path. Cost lands at the same `usage.cost.total_cost` path as before.
//
// 2. Tavily. Contract verified against docs.tavily.com. Free tier is 1,000
//    credits a month with no card, and cost is driven by search_depth alone
//    (basic 1 credit), so it is the cheap safety net when Perplexity fails
//    or its key runs dry. Worth knowing when reading scores later: `tavily`
//    is itself a registered miner on this network scoring ~0.99 on
//    WEB_SEARCH, so its upstream can match that miner's evidence but not
//    beat it on data, only on wording.

import { guarded, SpendCapError } from './spendGuard.js';
import { consensusSearch, consensusConfigured } from './consensus.js';
import { providerDisabled, disableProvider } from './llmProviders.js';

const PERPLEXITY_URL = 'https://api.perplexity.ai/v1/agent';
const TAVILY_URL = 'https://api.tavily.com/search';

// Telegraph cancels a question at 30 seconds and books it as a miss, so the
// whole chain has to finish inside that, not each provider separately. Two
// providers at their own 12s ceiling would stack to 24s plus request
// overhead and land on the cutoff.
//
// So there is one budget for the whole call, not one per provider: the
// deadline is set once in searchWeb and every provider gets whatever is
// left of it. A slow Perplexity therefore eats into Tavily's time rather
// than adding to it, and the route can never exceed the total.
const TOTAL_BUDGET_MS = 18_000;

// A provider that has not answered in this long is not going to be worth
// waiting for when another one is still untried, so the first provider is
// capped below the total to leave the second a usable share.
const FIRST_PROVIDER_MS = 11_000;

// Below this there is not enough time left for another provider to do
// anything useful, so the chain stops rather than starting a call it will
// have to abort.
const MIN_USEFUL_MS = 2_500;

// The graded field is compared against a plain ground-truth sentence, so the
// model is told to write one. Without this Perplexity returns markdown
// headings and bullet lists, which the stripper below can only partly undo.
//
// Measured 2026-09-16 against 5 straight scoring rounds: WEB_SEARCH sat at
// ~1e-11 (essentially "no answer") every round while the #1 miner sat at
// ~0.9999, despite our answers being real, correct, and well-sourced. The
// live traffic sample showed why: a hard, compound question ("senior backend
// engineer, $160k+, 4-day week, remote or London") got the honest reply "I
// couldn't verify any current role matching all of those requirements" --
// true, but a hedge scores near zero against a text-similarity grader the
// same way an empty answer does. The line below tells the model to always
// commit to its single best-supported answer instead, which costs nothing on
// the easy questions we were already winning and should stop the hedge from
// costing the score on the hard ones.
const ANSWER_STYLE = 'You are answering a factual question for an automated system. '
  + 'Reply with one to three plain prose sentences that directly answer the question and state the key facts. '
  + 'Always commit to your single best-supported answer, even if the evidence is partial or imperfect. '
  + 'Never reply that you could not verify, confirm, or find a match, and never list what is missing instead of answering -- '
  + 'state the closest real answer the sources support instead. '
  + 'Use no markdown, no bold, no bullet points, no headings, and no citation markers. '
  + 'Do not preface the answer or restate the question.';

export class WebSearchError extends Error {}

export function hasWebSearchProvider() {
  return Boolean(process.env.PERPLEXITY_API_KEY || process.env.TAVILY_API_KEY || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
}

// Whatever is left of the shared budget, capped so the first provider
// cannot consume all of it.
function remainingMs(options, cap) {
  const left = options.deadline - Date.now();
  return Math.min(left, cap ?? left);
}

// Even when asked for plain prose the model still emits **bold** and
// trailing [2][4][17] reference markers, both measured live 2026-08-31.
// They are noise against a ground-truth sentence, so they come off here
// rather than being trusted not to appear.
function stripAnswerMarkup(text) {
  return String(text)
    .replace(/\[\d+\](?:\[\d+\])*/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function postJson(url, { key, body, signal }) {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

// Every Perplexity search passes the spend guard (cache, daily and per-caller
// caps). A cap hit reads like any other provider failure to searchWeb().
async function callPerplexity(query, options) {
  if (providerDisabled('perplexity')) throw new WebSearchError('perplexity is paused after a refusal');
  try {
    return await guarded(JSON.stringify(['search', query]), () => callPerplexityRaw(query, options), { searches: true });
  } catch (err) {
    if (err instanceof SpendCapError) throw new WebSearchError(err.message);
    // No credit, a refused key or a forbidden plan will not fix itself in the
    // next second, so stop paying a round trip for it on every question.
    if (/no credit|rejected our key|status 40[123]/.test(String(err?.message))) disableProvider('perplexity');
    throw err;
  }
}

async function callPerplexityRaw(query, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs);
  try {
    const res = await postJson(PERPLEXITY_URL, {
      key: process.env.PERPLEXITY_API_KEY,
      signal: controller.signal,
      body: {
        model: process.env.PERPLEXITY_MODEL || 'perplexity/sonar',
        instructions: ANSWER_STYLE,
        input: [{ type: 'message', role: 'user', content: query }],
        // The answer wanted here is a few sentences. Left unbounded the
        // model writes several paragraphs, which costs more and reads
        // further from the ground-truth sentence it is scored against.
        max_output_tokens: 400,
        // This service exists to search, so the tool is always on, unlike
        // llmComplete.js's opt-in disableSearch (that file backs pure text
        // transformations that should not search at all). tool_choice
        // 'required' forces an actual search every call rather than
        // leaving it to the model's own judgment (the default 'auto'):
        // verified live 2026-09-18 that a simple question ("capital of
        // France") skipped searching under 'auto' and came back with an
        // empty results array, which starves any route that always wants
        // a citation list to grade against.
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
      },
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      if (errBody?.error?.type === 'insufficient_quota') throw new WebSearchError('the perplexity key has no credit left');
      if (res.status === 401) throw new WebSearchError('perplexity rejected our key');
      if (res.status === 402) throw new WebSearchError('the perplexity key has no credit left');
      if (res.status === 429) throw new WebSearchError('perplexity is rate limiting us');
      const why = String(errBody?.error?.message ?? errBody?.detail ?? '').slice(0, 160);
      throw new WebSearchError(`perplexity request failed with status ${res.status}${why ? `: ${why}` : ''}`);
    }

    const body = await res.json();
    const outputs = Array.isArray(body?.output) ? body.output : [];
    const messageItem = [...outputs].reverse().find((o) => o?.type === 'message');
    const textPart = messageItem?.content?.find?.((c) => c?.type === 'output_text');
    const raw = textPart?.text;
    const searchItem = outputs.find((o) => o?.type === 'search_results');
    const results = (searchItem?.results ?? []).map((r) => ({
      title: r.title ?? null,
      url: r.url ?? null,
      snippet: typeof r.snippet === 'string' ? r.snippet : '',
      score: null,
    }));

    return {
      answer: typeof raw === 'string' && raw.trim() ? stripAnswerMarkup(raw) : null,
      results,
      provider: 'perplexity',
      cost_usd: Number.isFinite(body?.usage?.cost?.total_cost) ? body.usage.cost.total_cost : null,
    };
  } catch (err) {
    if (err instanceof WebSearchError) throw err;
    if (err.name === 'AbortError') throw new WebSearchError('perplexity did not respond in time');
    throw new WebSearchError(err.message);
  } finally {
    clearTimeout(timer);
  }
}

// Tavily's own `answer` is documented as appearing only when requested and
// can come back empty on a query nothing matched. Composing a fallback
// sentence from the top result keeps a thin answer rather than none at all,
// because an empty graded field scores zero however good the JSON beneath
// it is.
function composeFromResults(query, results) {
  if (!results.length) return null;
  const top = results[0];
  return `The most relevant source found for "${query}" is ${top.title} (${top.url}): ${top.snippet}`;
}

// TAVILY_API_KEY may hold several keys separated by commas. A key that runs
// out of credit (432/433) or is refused (401) is set aside for a while and
// the next key answers the same request, so topping up needs no redeploy.
const TAVILY_KEY_REST_MS = 6 * 60 * 60 * 1000;
const tavilyResting = new Map();

async function postTavily(body, signal) {
  const keys = String(process.env.TAVILY_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
  const live = keys.filter((k) => (tavilyResting.get(k) ?? 0) <= Date.now());
  let res = null;
  // When every key is resting, try them all again rather than give up.
  for (const key of live.length ? live : keys) {
    res = await postJson(TAVILY_URL, { key, signal, body });
    if (res.status !== 432 && res.status !== 433 && res.status !== 401) return res;
    tavilyResting.set(key, Date.now() + TAVILY_KEY_REST_MS);
  }
  return res;
}

async function callTavily(query, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs);
  try {
    const res = await postTavily({
        query,
        topic: options.topic,
        search_depth: 'basic',
        // 'advanced' buys a fuller written reply at no extra credit, and the
        // written reply is the whole point here: miner.yaml grades `answer`,
        // so a list of links with no sentence over it scores near zero.
        include_answer: 'advanced',
        max_results: options.maxResults,
        include_raw_content: false,
        include_images: false,
    }, controller.signal);

    if (!res.ok) {
      // 432/433 are Tavily's own plan and pay-as-you-go ceilings, named
      // apart from a generic failure because they mean the key ran out of
      // credit, which is a billing problem to go fix rather than an outage
      // to wait out.
      if (res.status === 432 || res.status === 433) throw new WebSearchError('the tavily key has no credit left');
      if (res.status === 401) throw new WebSearchError('tavily rejected our key');
      if (res.status === 429) throw new WebSearchError('tavily is rate limiting us');
      throw new WebSearchError(`tavily request failed with status ${res.status}`);
    }

    const body = await res.json();
    const results = (body?.results ?? []).map((r) => ({
      title: r.title ?? null,
      url: r.url ?? null,
      // Tavily calls this `content`, but it is a snippet of the page rather
      // than the page, and carrying that name downstream invites the
      // mistake of treating it as the full text.
      snippet: typeof r.content === 'string' ? r.content : '',
      score: Number.isFinite(r.score) ? r.score : null,
    }));

    const answer = (typeof body?.answer === 'string' && body.answer.trim())
      ? stripAnswerMarkup(body.answer)
      : composeFromResults(query, results);

    return { answer, results, provider: 'tavily', cost_usd: null };
  } catch (err) {
    if (err instanceof WebSearchError) throw err;
    if (err.name === 'AbortError') throw new WebSearchError('tavily did not respond in time');
    throw new WebSearchError(err.message);
  } finally {
    clearTimeout(timer);
  }
}


// Keyless last resort. Perplexity and Tavily both run on paid plans that can
// run dry (both did, 2026-11), and the model-only vote has no sources, so a
// search with no paid provider left used to answer with an unsourced guess or
// not at all. Wikipedia and Hacker News Algolia are free, need no key and
// return real pages with real URLs, so the answer always names its sources.
async function getJsonFree(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'txlens-miner/1.0 (web search fallback)', Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function firstSentences(text, max) {
  const parts = String(text || '').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
  return parts.slice(0, max).join('').trim() || String(text || '').trim().slice(0, 300);
}

export async function freeSearch(query, options = {}) {
  // Opt-in per caller. Most routes wrap the user's text in a task prompt, and
  // a Wikipedia extract is the wrong answer to a wrapped prompt.
  if (options.enabled !== true || process.env.WEB_SEARCH_FREE_FALLBACK === 'off') return null;
  const budget = Math.max(options.budgetMs ?? 8000, 2500);
  const q = encodeURIComponent(query);
  const [wiki, hn] = await Promise.all([
    getJsonFree(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&srlimit=3&origin=*`, budget),
    getJsonFree(`https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=story&hitsPerPage=5`, budget),
  ]);
  const results = [];
  let answer = null;
  const wikiHits = wiki?.query?.search ?? [];
  if (wikiHits.length) {
    const title = wikiHits[0].title;
    const sum = await getJsonFree(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, Math.min(budget, 5000));
    const extract = sum?.extract ? firstSentences(sum.extract, 2) : null;
    for (const h of wikiHits) {
      results.push({ title: h.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`, snippet: String(h.snippet || '').replace(/<[^>]+>/g, ''), score: null });
    }
    if (extract) answer = extract;
  }
  const hnHits = (hn?.hits ?? []).filter((h) => h?.title);
  for (const h of hnHits) {
    results.push({ title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, snippet: `Hacker News story from ${String(h.created_at || '').slice(0, 10)}, ${h.points ?? 0} points`, score: null });
  }
  if (!answer && hnHits.length) {
    const top = hnHits[0];
    answer = `The most recent relevant story found for "${query}" is "${top.title}", posted ${String(top.created_at || '').slice(0, 10)}.`;
  }
  if (!answer) return null;
  return { answer, results, provider: 'free-search', cost_usd: 0 };
}

export async function searchWeb(query, options = {}) {
  const topic = options.topic === 'news' || options.topic === 'finance' ? options.topic : 'general';
  const maxResults = Math.min(Math.max(Number(options.maxResults) || 5, 1), 20);

  // The caller's budget wins over the env override. This is the real change
  // here, and it exists for the refusal fallback: /web-search sets its own
  // generous deadline, while the fallback derives a much tighter one from
  // whatever is left of Telegraph's 30s cut after the route already ran.
  // The previous order read the env var first, so WEB_SEARCH_BUDGET_MS tuned
  // for /web-search would silently override the fallback's remaining time and
  // push a response past that cut. Precedence, not NaN, was the risk: the old
  // expression chained with ||, which coerces NaN away on its own.
  //
  // The env read is still validated rather than chained, because ?? does NOT
  // fall through on NaN. Written as `options.budgetMs ?? Number(env) ?? …` an
  // unset var yields NaN, every provider aborts on the first tick, and the
  // whole WEB_SEARCH intent answers 502. Number.isFinite is what rules that
  // out, and a non-positive value is rejected for the same reason.
  const envBudget = Number(process.env.WEB_SEARCH_BUDGET_MS);
  const total = options.budgetMs
    ?? (Number.isFinite(envBudget) && envBudget > 0 ? envBudget : TOTAL_BUDGET_MS);
  const deadline = Date.now() + total;

  // With Tavily plus Groq and/or Gemini configured, an answer must be agreed by
  // at least two voters. Disagreement is reported, not guessed. If too few
  // voters answered, the older best-effort chain below still runs.
  if (consensusConfigured()) {
    const outcome = await consensusSearch(query, { topic, maxResults, budgetMs: remainingMs({ deadline }, 15_000), tavily: callTavily }).catch(() => null);
    if (outcome?.status === 'consensus') {
      // The voters are models with no pages behind them, so attach real
      // sources from the keyless search when the vote came back without any.
      let results = outcome.results ?? [];
      if (!results.length) {
        const free = await freeSearch(query, { enabled: options.allowFree === true, budgetMs: Math.min(Math.max(remainingMs({ deadline }), 2500), 6000) }).catch(() => null);
        if (free) results = free.results;
      }
      return {
        answer: outcome.answer, results, provider: 'consensus', cost_usd: 0, topic,
        votes: { agree: outcome.agree, total: outcome.total, voters: outcome.voters },
      };
    }
    if (outcome?.status === 'inconclusive' && options.bestEffort && outcome.bestEffort) {
      // Open-ended research: models word a paragraph differently every time,
      // so a split is normal. A real answer beats "No sources matched".
      let results = outcome.results ?? [];
      if (!results.length) {
        const free = await freeSearch(query, { enabled: options.allowFree === true, budgetMs: Math.min(Math.max(remainingMs({ deadline }), 2500), 6000) }).catch(() => null);
        if (free) results = free.results;
      }
      return { answer: outcome.bestEffort, results, provider: 'consensus-split', cost_usd: 0, topic, votes: { total: outcome.voters.length, positions: outcome.voters } };
    }
    if (outcome?.status === 'inconclusive') {
      const free = await freeSearch(query, { enabled: options.allowFree === true, budgetMs: Math.min(Math.max(remainingMs({ deadline }), 2500), 8000) }).catch(() => null);
      if (free) return { ...free, topic };
      return { answer: null, results: outcome.results, provider: 'consensus', cost_usd: 0, topic, inconclusive: true, votes: { total: outcome.voters.length, positions: outcome.voters } };
    }
  }

  // Perplexity leads because it writes the answer sentence the engine
  // actually grades. Tavily follows as the free safety net.
  const providers = [];
  if (process.env.PERPLEXITY_API_KEY && !providerDisabled('perplexity')) providers.push(callPerplexity);
  if (process.env.TAVILY_API_KEY) providers.push(callTavily);
  if (!providers.length) throw new WebSearchError('no search provider is configured');

  let lastError = null;
  let attempted = false;
  for (let i = 0; i < providers.length; i += 1) {
    const isLast = i === providers.length - 1;
    // The last provider may use everything left; earlier ones are capped so
    // they cannot starve it.
    const budgetMs = remainingMs({ deadline }, isLast ? null : FIRST_PROVIDER_MS);
    if (budgetMs < MIN_USEFUL_MS) break;

    let outcome;
    attempted = true;
    try {
      outcome = await providers[i](query, { topic, maxResults, budgetMs });
    } catch (err) {
      // One provider being down is not an outage while another can still
      // answer, so the failure is held and the chain continues. Only the
      // last reason reaches the caller.
      lastError = err;
      continue;
    }

    // An answer is what we came for, so take it. A provider that answered
    // but found nothing is worth retrying on the next one, unless there is
    // no next one, in which case its empty result is the honest outcome:
    // matching nothing is an answer, not a failure, and the route reports
    // it that way rather than as our own outage.
    if (outcome.answer) return { ...outcome, topic };
    if (isLast) return { ...outcome, topic };
    lastError = new WebSearchError(`${outcome.provider} returned nothing usable`);
  }

  if (lastError || !attempted) {
    const free = await freeSearch(query, { enabled: options.allowFree === true, budgetMs: 8000 }).catch(() => null);
    if (free) return { ...free, topic };
  }
  if (lastError) throw lastError;
  // Running out of budget before any provider could even be called is our
  // failure and keeps a real failure code. Returning it as an empty result
  // would report our own timeout as "the web had nothing on this", hiding
  // downtime behind what looks like a legitimate answer.
  if (!attempted) throw new WebSearchError('ran out of time before any search provider could answer');
  return { answer: null, results: [], topic, provider: null, cost_usd: null };
}
