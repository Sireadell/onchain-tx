// Free-allowance language model providers: Groq and Google Gemini. Neither
// searches the web by itself here (Gemini can, when GEMINI_GROUNDING=1); they
// answer from the text the caller gives them. Both are used two ways: as the
// fallback for llmComplete.js when Perplexity is unavailable, and as voters in
// consensus.js.
//
// Model names change often, so both are env settings with a working default:
//   GROQ_MODEL    (default openai/gpt-oss-120b)
//   GEMINI_MODEL  (default gemini-3-flash-preview)
// When that main model is out of its free daily allowance, smaller models on the
// same key are tried in turn (groqModels / geminiModels below). A wrong model
// name shows up as a 404 whose reason is carried in the error.

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

const groqModel = () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const geminiModel = () => process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

// Each model has its own free daily allowance, so when the main one is used up
// the smaller models on the same key still answer. They are tried in order.
export const groqModels = () => [...new Set([groqModel(), 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'])];
export const geminiModels = () => [...new Set([geminiModel(), 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemma-4-31b-it'])];
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
  modelPausedUntil.clear();
}

// One model out of allowance (or missing) pauses only that model, so the next
// model in the list is used straight away on the following requests too.
const modelPausedUntil = new Map();
const modelPaused = (provider, model) => {
  if (pausingOff()) return false;
  const key = `${provider}/${model}`;
  const until = modelPausedUntil.get(key);
  if (!until) return false;
  if (Date.now() >= until) { modelPausedUntil.delete(key); return false; }
  return true;
};
const pauseModel = (provider, model, ms) => {
  if (!pausingOff()) modelPausedUntil.set(`${provider}/${model}`, Date.now() + ms);
};

// Runs `attempt(model, budgetMs)` down the model list. A 429 (allowance used),
// a 404 (model gone) or a server error moves on to the next model; anything
// else (bad key, bad request) is the same for every model and is thrown.
async function tryModels(provider, models, budgetMs, attempt) {
  const deadline = Date.now() + budgetMs;
  const reasons = [];
  let last = null;
  for (const model of models) {
    if (modelPaused(provider, model)) continue;
    const left = deadline - Date.now();
    if (reasons.length && left < 1_500) break;
    try {
      return await attempt(model, Math.max(left, 1_500));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      const status = err.status;
      // A daily/quota limit holds for a while; a per-minute limit clears in seconds.
      if (status === 429) pauseModel(provider, model, /per day|tpd|quota|exceeded/i.test(err.message) ? 10 * 60_000 : 3_000);
      else if (status === 404) pauseModel(provider, model, 60 * 60_000);
      else if (!(status >= 500) && status !== 400 && status !== null) throw err;
      reasons.push(`${model}: ${err.message}`);
      last = err;
    }
  }
  if (!last) throw new ProviderError(`every ${provider} model is paused until its allowance resets`, { status: 429, provider });
  throw new ProviderError(reasons.join(' | '), { status: last.status, provider });
}

async function post(url, { headers, body, budgetMs, provider, keepOnNotFound = false }) {
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
      if ([401, 403, 404].includes(res.status) && !(keepOnNotFound && res.status === 404)) disableProvider(provider, res.status === 404 ? 30 * 60_000 : 6 * 3_600_000);
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

export async function groqComplete(system, user, { maxTokens = 400, temperature = 0.1, budgetMs = 9_000, model = null } = {}) {
  if (!hasGroq()) throw new ProviderError('GROQ_API_KEY is not set', { provider: 'groq' });
  if (providerDisabled('groq')) throw new ProviderError('groq is paused after a refusal', { provider: 'groq' });
  const one = async (name, ms) => {
    const body = await post(GROQ_URL, {
      provider: 'groq',
      budgetMs: ms,
      keepOnNotFound: true,
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: {
        model: name,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        temperature,
        ...(/gpt-oss/i.test(name) ? { reasoning_effort: 'low' } : {}),
      },
    });
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError(`groq ${name} returned no text`, { provider: 'groq', status: 502 });
    return { text: text.trim(), cost_usd: 0, provider: 'groq', model: name };
  };
  return tryModels('groq', model ? [model] : groqModels(), budgetMs, one);
}

export async function geminiComplete(system, user, { maxTokens = 400, temperature = 0.1, budgetMs = 9_000, grounded = process.env.GEMINI_GROUNDING === '1', model = null } = {}) {
  if (!hasGemini()) throw new ProviderError('GEMINI_API_KEY is not set', { provider: 'gemini' });
  if (providerDisabled('gemini')) throw new ProviderError('gemini is paused after a refusal', { provider: 'gemini' });
  const one = async (name, ms) => {
    // Gemma models take no system instruction, so it is placed ahead of the text.
    const gemma = /gemma/i.test(name);
    const body = await post(geminiUrl(name), {
      provider: 'gemini',
      budgetMs: ms,
      keepOnNotFound: true,
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: {
        ...(gemma ? {} : { systemInstruction: { parts: [{ text: system }] } }),
        contents: [{ role: 'user', parts: [{ text: gemma ? `${system}

${user}` : user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature,
          // Flash models spend part of the token allowance on hidden thinking,
          // which can leave the visible answer cut off. (3.5 models reject the setting.)
          ...(/flash/i.test(name) && !/3\.5/.test(name) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
        ...(grounded && !gemma ? { tools: [{ google_search: {} }] } : {}),
      },
    });
    const text = (body?.candidates?.[0]?.content?.parts ?? []).filter((p) => !p?.thought).map((p) => p?.text ?? '').join('').trim();
    if (!text) throw new ProviderError(`gemini ${name} returned no text`, { provider: 'gemini', status: 502 });
    return { text, cost_usd: 0, provider: 'gemini', model: name };
  };
  return tryModels('gemini', model ? [model] : geminiModels(), budgetMs, one);
}
