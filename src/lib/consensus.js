// Consensus answers for web questions. Tavily searches the web and writes its
// own answer. Groq and Gemini then each answer the same question from the same
// evidence. An answer is only returned when at least two voters agree on it.
// Disagreement is reported as inconclusive, never papered over with a guess.
//
// A voter that errors or times out is simply absent. If fewer than two voters
// answered at all, consensus is "unavailable" and the caller falls back to its
// older best-effort chain.

import { guarded } from './spendGuard.js';
import { groqComplete, geminiComplete, hasGroq, hasGemini } from './llmProviders.js';

export function consensusConfigured() {
  return Boolean(process.env.TAVILY_API_KEY) && (hasGroq() || hasGemini());
}

const STOP = new Set(['that', 'this', 'with', 'from', 'were', 'have', 'been', 'which', 'their', 'there', 'about', 'would', 'could', 'also', 'into', 'than', 'then', 'they', 'them', 'what', 'when', 'where', 'while', 'after', 'before', 'being', 'does', 'will']);

function tokens(text) {
  return String(text ?? '').toLowerCase().replace(/(\d),(?=\d{3})/g, '$1').replace(/[^a-z0-9.\s]/g, ' ').replace(/\.(?!\d)/g, ' ')
    .split(/\s+/).filter(Boolean);
}

// The words that carry a claim: numbers, and words of 4+ letters that are not
// filler.
function keyTokens(text) {
  return [...new Set(tokens(text).filter((t) => /\d/.test(t) || (t.length >= 4 && !STOP.has(t))))];
}

// How much of a short claim shows up in another voter's fuller answer.
function coverage(short, full) {
  const key = keyTokens(short);
  if (!key.length) return 0;
  const have = new Set(tokens(full));
  return key.filter((t) => have.has(t)).length / key.length;
}

export function agrees(a, b, threshold = 0.6) {
  return coverage(a.short, b.full) >= threshold || coverage(b.short, a.full) >= threshold;
}

// Picks the largest group of mutually agreeing voters.
export function findConsensus(voters, minAgree = 2) {
  let best = [];
  for (const v of voters) {
    const group = voters.filter((o) => o === v || agrees(v, o));
    if (group.length > best.length) best = group;
  }
  return best.length >= minAgree ? best : null;
}

const VOTER_SYSTEM = 'You answer a factual question for an automated checker. Use the evidence supplied and your own knowledge. '
  + 'Reply with ONLY a JSON object, no markdown: {"short":"the bare answer in 12 words or fewer","full":"one to three plain sentences stating the answer with exact names, numbers and dates"}. '
  + 'Commit to the best-supported answer. If the evidence conflicts with what you know to be true, trust what is true.';

function parseVote(text) {
  const raw = String(text ?? '');
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const j = JSON.parse(match[0]);
      if (typeof j.short === 'string' && typeof j.full === 'string' && j.short.trim() && j.full.trim()) {
        return { short: j.short.trim(), full: j.full.trim() };
      }
    } catch { /* fall through to plain text */ }
  }
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat ? { short: flat.split(/(?<=[.!?])\s/)[0].slice(0, 120), full: flat } : null;
}

function evidenceBlock(results) {
  return (results ?? []).slice(0, 5).map((r, i) => `[${i + 1}] ${r.title ?? ''} (${r.url ?? ''}): ${String(r.snippet ?? '').slice(0, 500)}`).join('\n');
}

const firstSentence = (text) => String(text ?? '').split(/(?<=[.!?])\s/)[0].slice(0, 160);

// tavily: async (query, {topic, maxResults, budgetMs}) -> {answer, results}
// Returns { status: 'consensus'|'inconclusive'|'unavailable', ... }.
export async function consensusSearch(query, { topic, maxResults, budgetMs, tavily }) {
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);

  const tav = await guarded(JSON.stringify(['tavily', query, topic]), () => tavily(query, { topic, maxResults, budgetMs: Math.min(left(), 9_000) }), { kind: 'tavily' })
    .catch(() => null);

  const voters = [];
  if (tav?.answer) voters.push({ name: 'tavily', short: firstSentence(tav.answer), full: tav.answer });

  const evidence = evidenceBlock(tav?.results);
  const userContent = `Question: ${query}\n\nEvidence from a web search:\n${evidence || '(no web evidence was found)'}`;
  const ask = (name, fn) => guarded(JSON.stringify([name, query, evidence]), () => fn(VOTER_SYSTEM, userContent, { budgetMs: Math.max(Math.min(left(), 9_000), 1_500) }), { kind: 'free' })
    .then((out) => ({ name, ...parseVote(out.text) }))
    .catch(() => null);
  const calls = [];
  if (hasGroq()) calls.push(ask('groq', groqComplete));
  if (hasGemini()) calls.push(ask('gemini', geminiComplete));
  for (const v of await Promise.all(calls)) if (v?.short && v?.full) voters.push(v);

  const results = tav?.results ?? [];
  if (voters.length < 2) return { status: 'unavailable', voters: voters.map((v) => v.name), results };

  const group = findConsensus(voters);
  if (!group) {
    // Kept for open-ended callers (research) that prefer the fullest model
    // answer over no answer. Fact checks ignore this and report the split.
    const best = [...voters].sort((a, b) => (a.name === 'tavily') - (b.name === 'tavily') || b.full.length - a.full.length)[0];
    return { status: 'inconclusive', voters: voters.map((v) => ({ name: v.name, short: v.short })), results, bestEffort: best.full };
  }

  // The cleanest wording wins: a model's sentence over Tavily's, then the longest.
  const preferred = [...group].sort((a, b) => (a.name === 'tavily') - (b.name === 'tavily') || b.full.length - a.full.length)[0];
  return {
    status: 'consensus',
    answer: preferred.full,
    agree: group.length,
    total: voters.length,
    voters: group.map((v) => v.name),
    results,
  };
}
