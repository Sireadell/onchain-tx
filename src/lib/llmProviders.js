// Free-allowance language model providers: Groq and Google Gemini. Neither
// searches the web by itself here (Gemini can, when GEMINI_GROUNDING=1); they
// answer from the text the caller gives them. Both are used two ways: as the
// fallback for llmComplete.js when Perplexity is unavailable, and as voters in
// consensus.js.
//
// Model names change often, so both are env settings with a working default:
//   GROQ_MODEL    (default llama-3.3-70b-versatile)
//   GEMINI_MODEL  (default gemini-3.8-flash)
// A wrong model name shows up as a 404 whose reason is carried in the error.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

export class ProviderError extends Error {
  constructor(message, { status = null, provider = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
  }
}

export const hasGroq = () => Boolean(process.env.GROQ_API_KEY);
export const hasGemini = () => Boolean(process.env.GEMINI_API_KEY);

// A provider that refuses our key or has no credit will refuse the next
// request too, so it is skipped for a while instead of costing a round trip
// on every question.
const disabledUntil = new Map();
// Route tests stub providers with deliberate refusals, so under `node --test`
// nothing is paused unless a test sets LLM_GUARD_FORCE.
const pausingOff = () => Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.LLM_GUARD_FORCE;
export function providerDisabled(name) {
  if (pausingOff()) return false;
  const until = disabledUntil.get(name);
  if (!until) return false;
  if (Date.now() >= until) { disabledUntil.delete(name); return false; }
  return true;
}
export function disableProvider(name, ms = 6 * 3_600_000) {
  if (pausingOff()) return;
  disabledUntil.set(name, Date.now() + ms);
}
export function resetProviderState() {
  disabledUntil.clear();
}

async function post(url, { headers, body, budgetMs, provider }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      const why = String(errBody?.error?.message ?? errBody?.message ?? '').slice(0, 160);
      if ([401, 403, 404].includes(res.status)) disableProvider(provider, res.status === 404 ? 30 * 60_000 : 6 * 3_600_000);
      throw new ProviderError(`${provider} request failed with status ${res.status}${why ? `: ${why}` : ''}`, { status: res.status, provider });
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err.name === 'AbortError') throw new ProviderError(`${provider} did not respond in time`, { provider });
    throw new ProviderError(`${provider}: ${err.message}`, { provider });
  } finally {
    clearTimeout(timer);
  }
}

export async function groqComplete(system, user, { maxTokens = 400, temperature = 0.1, budgetMs = 9_000 } = {}) {
  if (!hasGroq()) throw new ProviderError('GROQ_API_KEY is not set', { provider: 'groq' });
  if (providerDisabled('groq')) throw new ProviderError('groq is paused after a refusal', { provider: 'groq' });
  const body = await post(GROQ_URL, {
    provider: 'groq',
    budgetMs,
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: {
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
      temperature,
    },
  });
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new ProviderError('groq returned no text', { provider: 'groq' });
  return { text: text.trim(), cost_usd: 0, provider: 'groq' };
}

export async function geminiComplete(system, user, { maxTokens = 400, temperature = 0.1, budgetMs = 9_000, grounded = process.env.GEMINI_GROUNDING === '1' } = {}) {
  if (!hasGemini()) throw new ProviderError('GEMINI_API_KEY is not set', { provider: 'gemini' });
  if (providerDisabled('gemini')) throw new ProviderError('gemini is paused after a refusal', { provider: 'gemini' });
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const body = await post(geminiUrl(model), {
    provider: 'gemini',
    budgetMs,
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
        // Flash models spend part of the token allowance on hidden thinking,
        // which can leave the visible answer cut off.
        ...(/flash/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
      ...(grounded ? { tools: [{ google_search: {} }] } : {}),
    },
  });
  const text = (body?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? '').join('').trim();
  if (!text) throw new ProviderError('gemini returned no text', { provider: 'gemini' });
  return { text, cost_usd: 0, provider: 'gemini' };
}
