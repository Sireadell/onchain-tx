// Keyless factual answers from Wikipedia: search for the best page for a
// question, then read its lead summary. Used by QUESTION_ANSWERING so the
// intent answers real questions without any paid key; an LLM answer is tried
// first by the route when one is available.

const API = 'https://en.wikipedia.org/w/api.php';
const SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const TIMEOUT_MS = 4_000;

const LEAD_WORDS = /^\s*(?:please\s+)?(?:tell me|can you tell me|do you know|could you tell me|i want to know|i would like to know)?\s*,?\s*(?:what|who|whom|when|where|why|which|how)\s+(?:is|are|was|were|did|does|do|many|much|long|old|far|tall|big)?\s*/i;
const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are', 'was', 'were', 'did', 'does', 'do', 'and', 'or', 'by', 'with', 'as', 'it', 'its', 'that', 'this', 'from', 'be', 'been', 'has', 'have', 'had']);

export function searchTerms(question) {
  const q = String(question ?? '').replace(/[?!"“”]/g, ' ').replace(LEAD_WORDS, '').replace(/\s+/g, ' ').trim();
  return q.length >= 2 ? q : String(question ?? '').trim();
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'TxLens/1.0 (telegraph miner)', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`wikipedia answered ${res.status}`);
  return res.json();
}

// Keeps whole sentences up to `max` characters.
export function leadSentences(text, max = 700) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 120 ? cut.slice(0, end + 1) : `${cut.trimEnd()}...`;
}

export async function wikiAnswer(question) {
  const terms = searchTerms(question);
  const url = `${API}?action=query&list=search&srsearch=${encodeURIComponent(terms)}&srlimit=3&format=json&origin=*`;
  const found = await getJson(url);
  const hits = found?.query?.search ?? [];
  if (!hits.length) return null;
  const words = terms.toLowerCase().split(/\W+/).filter((w) => w && !STOP.has(w));
  // Prefer the hit whose title shares the most words with the question.
  const scored = hits.map((h, i) => ({ h, score: words.filter((w) => h.title.toLowerCase().includes(w)).length * 10 - i }));
  scored.sort((a, b) => b.score - a.score);
  const title = scored[0].h.title;
  const page = await getJson(`${SUMMARY}${encodeURIComponent(title.replace(/ /g, '_'))}`);
  const extract = leadSentences(page?.extract);
  if (!extract) return null;
  return { title: page.title ?? title, extract, url: page?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` };
}
