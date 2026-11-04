// Grammar and spelling fixes from the public LanguageTool service. It needs no
// key and uses none of the language model allowances, so grammar checks keep
// working when Groq, Gemini and Perplexity are out of quota.
//
//   LANGUAGETOOL_URL  (default https://api.languagetool.org/v2/check)

const DEFAULT_URL = 'https://api.languagetool.org/v2/check';
const TIMEOUT_MS = 6_000;
const MAX_CHARS = 18_000;

export class LanguageToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LanguageToolError';
  }
}

function editDistance(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= y.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[y.length];
}

// The service lists its best guess first, but that is often a different word
// ("teem" -> "To teem", "victorie" -> "Victoria"). The smallest change that
// keeps the writer's capitalisation is the safest pick.
export function pickReplacement(original, candidates) {
  const options = candidates.map((c) => c.value).filter((v) => typeof v === 'string').slice(0, 6);
  if (options.length === 0) return null;
  const startsUpper = /^[A-Z]/.test(original);
  let best = null;
  let bestScore = Infinity;
  options.forEach((value, index) => {
    const caseMiss = /^[A-Z]/.test(value) === startsUpper ? 0 : 0.5;
    const score = editDistance(original, value) + caseMiss + index * 0.01;
    if (score < bestScore) { best = value; bestScore = score; }
  });
  return best;
}

export function applyMatches(text, matches) {
  const usable = matches
    .filter((m) => Number.isInteger(m.offset) && Number.isInteger(m.length) && m.length > 0 && Array.isArray(m.replacements))
    .sort((a, b) => a.offset - b.offset);
  const fixes = [];
  const picked = [];
  let end = -1;
  for (const m of usable) {
    if (m.offset < end) continue;
    const original = text.slice(m.offset, m.offset + m.length);
    const replacement = pickReplacement(original, m.replacements);
    if (replacement === null || replacement === original) continue;
    picked.push({ offset: m.offset, length: m.length, replacement });
    fixes.push(`${original} -> ${replacement}`);
    end = m.offset + m.length;
  }
  let corrected = text;
  for (const p of [...picked].reverse()) {
    corrected = corrected.slice(0, p.offset) + p.replacement + corrected.slice(p.offset + p.length);
  }
  return { corrected, fixes };
}

export async function correctWithLanguageTool(text, { language = 'auto', fetchImpl = fetch } = {}) {
  const input = String(text ?? '');
  if (!input.trim()) throw new LanguageToolError('no text to check');
  if (input.length > MAX_CHARS) throw new LanguageToolError('text is too long for the grammar service');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(process.env.LANGUAGETOOL_URL || DEFAULT_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ text: input, language: language === 'auto' ? 'en-US' : language }).toString(),
    });
    if (!res.ok) throw new LanguageToolError(`languagetool answered with status ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.matches)) throw new LanguageToolError('languagetool returned no match list');
    return applyMatches(input, body.matches);
  } catch (err) {
    if (err instanceof LanguageToolError) throw err;
    if (err.name === 'AbortError') throw new LanguageToolError('languagetool did not respond in time');
    throw new LanguageToolError(`languagetool: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
