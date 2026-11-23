// Fallbacks for intents that used to answer a provider outage with an error
// code. An error scores as no answer at all, so each of these gives the asker
// something real instead: a model answer from its own knowledge, a plain
// extract of the supplied text, a keyless translation, or fixed reference
// facts. Every caller says in its answer what the result rests on.

import { llmComplete, hasLlmProvider, frameInput, INJECTION_GUARD } from './llmComplete.js';

const MISS = /^\s*(?:i['’]?m sorry|sorry|i cannot|i can['’]?t|i am unable|unable to)\b/i;

// A language-model answer without live search; null when none can be had.
export async function modelAnswer(system, userText, { maxTokens = 450, budgetMs = 14_000, temperature = 0.2 } = {}) {
  if (!hasLlmProvider()) return null;
  try {
    const out = await llmComplete(`${system}${INJECTION_GUARD}`, frameInput(userText), { budgetMs, maxTokens, disableSearch: true, temperature });
    const text = String(out?.text ?? '').trim();
    if (!text || (MISS.test(text) && text.length < 200)) return null;
    return { text, provider: out.provider ?? 'language model' };
  } catch {
    return null;
  }
}

const STOP = new Set('a an the of to in on at for and or is are was were be been it its this that with as by from has have had not but they their he she we you i'.split(' '));

// Picks the sentences that carry the most frequent content words, in their
// original order, until the word or sentence limit is reached.
export function extractiveSummary(text, { maxWords = 60, maxSentences = 3 } = {}) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((x) => x.trim()).filter((x) => x.length > 15) ?? [];
  if (!sentences.length) return clean.split(' ').slice(0, maxWords).join(' ');
  const freq = new Map();
  for (const w of clean.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) if (!STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const scored = sentences.map((s, i) => {
    const words = s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
    const score = words.reduce((a, w) => a + (freq.get(w) ?? 0), 0) / Math.sqrt(words.length || 1) + (i === 0 ? 3 : 0);
    return { s, i, score, n: s.split(' ').length };
  }).sort((a, b) => b.score - a.score);
  const chosen = [];
  let total = 0;
  for (const c of scored) {
    if (chosen.length >= maxSentences) break;
    if (total + c.n > maxWords && chosen.length) continue;
    if (c.n > maxWords && !chosen.length) {
      chosen.push({ ...c, s: c.s.split(' ').slice(0, maxWords).join(' ') });
      total += maxWords;
      break;
    }
    chosen.push(c);
    total += c.n;
  }
  return chosen.sort((a, b) => a.i - b.i).map((c) => c.s).join(' ');
}

// How long the asker wants the summary: "under 40 words", "in two sentences".
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
export function summaryLimits(question) {
  const q = String(question ?? '').toLowerCase();
  const words = /(?:under|within|in|at most|max(?:imum)?(?: of)?|no more than|fewer than|less than)\s+(\d{1,3})\s+words/.exec(q)?.[1];
  const sent = /(?:in|into|under|within|at most)\s+(\d|one|two|three|four|five)\s+sentences?/.exec(q)?.[1];
  return {
    maxWords: words ? Math.max(8, Number(words) - 2) : 60,
    maxSentences: sent ? (NUM_WORDS[sent] ?? Number(sent)) : 3,
  };
}

// Keyless translation (MyMemory). Returns null on any failure.
const LANG_CODES = { english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', russian: 'ru', chinese: 'zh-CN', japanese: 'ja', korean: 'ko', arabic: 'ar', hindi: 'hi', dutch: 'nl', turkish: 'tr', polish: 'pl', swedish: 'sv', greek: 'el', hebrew: 'he', indonesian: 'id', vietnamese: 'vi', thai: 'th', ukrainian: 'uk', swahili: 'sw', yoruba: 'yo' };
export function languageCode(name) {
  return LANG_CODES[String(name ?? '').trim().toLowerCase()] ?? null;
}
export async function keylessTranslate(text, targetName, sourceName = null) {
  const to = languageCode(targetName);
  if (!to) return null;
  const from = (sourceName && languageCode(sourceName)) || 'Autodetect';
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(String(text).slice(0, 450))}&langpair=${encodeURIComponent(`${from}|${to}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(7_000), headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    const out = body?.responseData?.translatedText;
    if (!out || /MYMEMORY WARNING|INVALID/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

// Fixed, widely published credit-reporting facts for the general questions.
export function creditFacts(question) {
  const q = String(question ?? '').toLowerCase();
  const parts = [];
  if (/fico|credit score|score range|range/.test(q) || !/debt|dti|mortgage/.test(q)) {
    parts.push('FICO and VantageScore credit scores run from 300 to 850. FICO bands: 300-579 poor, 580-669 fair, 670-739 good, 740-799 very good, 800-850 exceptional, so a good score starts around 670.');
  }
  if (/debt-to-income|dti|mortgage|lender/.test(q)) {
    parts.push('For a mortgage, lenders generally want a total debt-to-income ratio of 36% or lower, will often accept up to 43% (the long-standing qualified-mortgage benchmark), and some programmes go to 45-50% with strong credit or savings. The housing-cost-only (front-end) ratio is usually targeted at about 28%.');
  }
  if (/factor|affect|lower|negativ|improve|raise|calculated|impact/.test(q)) {
    parts.push('A FICO score is built from payment history (35%), amounts owed or utilisation (30%), length of credit history (15%), new credit (10%) and credit mix (10%). Late payments, high card balances, new applications, collections and bankruptcies lower it the most.');
  }
  return parts.join(' ');
}
