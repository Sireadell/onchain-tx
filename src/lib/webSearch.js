// WEB_SEARCH backing service. Unlike every other lib in here, this one has
// no single authoritative provider to read a number from: the question can
// be about anything, so the answer is a live search plus the provider's own
// written reply.
//
// Two providers, tried in order, the same shape as the weather chain in
// weatherForecast.js.
//
// 1. Perplexity. Contract verified 2026-08-31 by calling it with the real
//    key rather than reading docs: POST https://api.perplexity.ai/chat/
//    completions, bearer auth, model `sonar`, and the answer at
//    choices[0].message.content with a top-level `search_results` array
//    carrying title/url/snippet. Measured cost was $0.00507 a question,
//    almost all of it a flat $0.005 request charge rather than tokens, so
//    question length barely moves the bill.
//    Note for anyone re-checking this: https://api.perplexity.ai/v1/agent
//    also exists but rejects a `messages` body outright (400, unknown
//    field). chat/completions is the working endpoint, not a deprecated one.
//
// 2. Tavily. Contract verified against docs.tavily.com. Free tier is 1,000
//    credits a month with no card, and cost is driven by search_depth alone
//    (basic 1 credit), so it is the cheap safety net when Perplexity fails
//    or its key runs dry. Worth knowing when reading scores later: `tavily`
//    is itself a registered miner on this network scoring ~0.99 on
//    WEB_SEARCH, so its upstream can match that miner's evidence but not
//    beat it on data, only on wording.

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';
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
const ANSWER_STYLE = 'You are answering a factual question for an automated system. '
  + 'Reply with one to three plain prose sentences that directly answer the question and state the key facts. '
  + 'Use no markdown, no bold, no bullet points, no headings, and no citation markers. '
  + 'Do not preface the answer or restate the question.';

export class WebSearchError extends Error {}

export function hasWebSearchProvider() {
  return Boolean(process.env.PERPLEXITY_API_KEY || process.env.TAVILY_API_KEY);
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

async function callPerplexity(query, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs);
  try {
    const res = await postJson(PERPLEXITY_URL, {
      key: process.env.PERPLEXITY_API_KEY,
      signal: controller.signal,
      body: {
        model: process.env.PERPLEXITY_MODEL || 'sonar',
        messages: [
          { role: 'system', content: ANSWER_STYLE },
          { role: 'user', content: query },
        ],
        // The answer wanted here is a few sentences. Left unbounded the
        // model writes several paragraphs, which costs more and reads
        // further from the ground-truth sentence it is scored against.
        max_tokens: 400,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new WebSearchError('perplexity rejected our key');
      if (res.status === 402) throw new WebSearchError('the perplexity key has no credit left');
      if (res.status === 429) throw new WebSearchError('perplexity is rate limiting us');
      throw new WebSearchError(`perplexity request failed with status ${res.status}`);
    }

    const body = await res.json();
    const raw = body?.choices?.[0]?.message?.content;
    const results = (body?.search_results ?? []).map((r) => ({
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

async function callTavily(query, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.budgetMs);
  try {
    const res = await postJson(TAVILY_URL, {
      key: process.env.TAVILY_API_KEY,
      signal: controller.signal,
      body: {
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
      },
    });

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

export async function searchWeb(query, options = {}) {
  const topic = options.topic === 'news' || options.topic === 'finance' ? options.topic : 'general';
  const maxResults = Math.min(Math.max(Number(options.maxResults) || 5, 1), 20);

  const total = Number(process.env.WEB_SEARCH_BUDGET_MS) || options.budgetMs || TOTAL_BUDGET_MS;
  const deadline = Date.now() + total;

  // Perplexity leads because it writes the answer sentence the engine
  // actually grades. Tavily follows as the free safety net.
  const providers = [];
  if (process.env.PERPLEXITY_API_KEY) providers.push(callPerplexity);
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

  if (lastError) throw lastError;
  // Running out of budget before any provider could even be called is our
  // failure and keeps a real failure code. Returning it as an empty result
  // would report our own timeout as "the web had nothing on this", hiding
  // downtime behind what looks like a legitimate answer.
  if (!attempted) throw new WebSearchError('ran out of time before any search provider could answer');
  return { answer: null, results: [], topic, provider: null, cost_usd: null };
}
