// Spending guard for every call that costs money (Perplexity). All paid calls
// go through guarded(), which gives three protections:
//   1. An identical request inside the cache window is answered from memory
//      and costs nothing, so repeating one question cannot drain credit.
//   2. Hard caps: dollars per day, calls per day, and calls per hour for any
//      single caller. Estimates are used until the provider reports the real
//      cost of a call.
//   3. A lifetime ceiling since boot, so a runaway loop stops well before the
//      prepaid credit is gone.
// When a cap is hit the call throws SpendCapError and the route falls back to
// its free source or reports a temporary failure. Nothing is charged.
// Counters live in memory, so a restart resets them. Set a monthly limit on the
// provider's own dashboard as the backstop for that.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const callerStore = new AsyncLocalStorage();

export class SpendCapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpendCapError';
  }
}

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const limits = () => ({
  dailyUsd: num('LLM_DAILY_USD_CAP', 0.75),
  dailyCalls: num('LLM_DAILY_CALL_CAP', 150),
  hourlyPerCaller: num('LLM_HOURLY_CALLS_PER_CALLER', 25),
  lifetimeUsd: num('LLM_LIFETIME_USD_CAP', 8),
  estimateSearchUsd: num('LLM_EST_SEARCH_USD', 0.012),
  estimatePlainUsd: num('LLM_EST_PLAIN_USD', 0.004),
  cacheMs: num('LLM_CACHE_MINUTES', 30) * 60_000,
  // Free-allowance providers (Groq, Gemini) and Tavily's monthly credits. They
  // cost no dollars, so they get call caps instead: Tavily's free plan is
  // 1,000 searches a month. The daily limit used to be 33 and is now the whole
  // month, so the free credits are used as fast as the scorer asks for them.
  freeDailyCalls: num('LLM_FREE_DAILY_CALLS', 1200),
  freeHourlyPerCaller: num('LLM_FREE_HOURLY_CALLS_PER_CALLER', 120),
  tavilyDailyCalls: num('TAVILY_DAILY_CALLS', 1000),
  tavilyHourlyPerCaller: num('TAVILY_HOURLY_CALLS_PER_CALLER', 1000),
});

// Who spent what today, so a cap hit can be traced to a caller and a route.
function note(caller, route, usd) {
  const key = `${caller} ${route}`;
  const row = state.spenders.get(key) ?? { calls: 0, usd: 0 };
  row.calls += 1;
  row.usd += usd;
  state.spenders.set(key, row);
}

function topSpenders() {
  return [...state.spenders].sort((a, b) => b[1].usd - a[1].usd).slice(0, 5)
    .map(([k, v]) => `${k}=${v.calls} calls $${v.usd.toFixed(3)}`).join('; ');
}

function capHit(message, caller, route) {
  console.warn(`SPEND_CAP_HIT ${message} | blocked: ${caller} ${route} | today: $${state.dayUsd.toFixed(3)}, ${state.dayCalls} calls | top: ${topSpenders()}`);
  throw new SpendCapError(message);
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_CACHE_ENTRIES = 500;

let state;
export function resetSpendGuard() {
  state = { dayStart: Date.now(), dayUsd: 0, dayCalls: 0, kindCalls: { free: 0, tavily: 0 }, lifetimeUsd: 0, callers: new Map(), spenders: new Map(), cache: new Map(), inflight: new Map() };
}
resetSpendGuard();

// Express middleware: remembers who is calling for the length of the request.
export function spendCallerMiddleware(req, _res, next) {
  callerStore.run({ caller: req.ip || 'unknown', route: req.path }, next);
}

function rollDay(now) {
  if (now - state.dayStart >= DAY_MS) {
    state.dayStart = now;
    state.dayUsd = 0;
    state.dayCalls = 0;
    state.kindCalls = { free: 0, tavily: 0 };
    state.spenders.clear();
  }
}

function checkCaller(now, caller, max, route) {
  const recent = (state.callers.get(caller) ?? []).filter((t) => now - t < HOUR_MS);
  if (recent.length >= max) capHit('this caller has reached the hourly limit for paid lookups', caller, route);
  recent.push(now);
  state.callers.set(caller, recent);
  if (state.callers.size > 5000) {
    for (const [k, v] of state.callers) if (!v.some((t) => now - t < HOUR_MS)) state.callers.delete(k);
  }
}

// key: anything that identifies the request. fn: the paid call, returning an
// object that may carry cost_usd. searches: true when the call runs a web
// search (costs more). Returns the result of fn, or a cached copy.
export async function guarded(key, fn, { searches = false, cache = true, kind = 'paid' } = {}) {
  // Route tests stub the provider and reuse the same questions across tests, so
  // the guard stands aside under `node --test` unless a test forces it on.
  if (process.env.NODE_TEST_CONTEXT && !process.env.LLM_GUARD_FORCE) return fn();
  const cfg = limits();
  const hash = createHash('sha256').update(String(key)).digest('hex');
  const now = Date.now();

  if (cache && cfg.cacheMs > 0) {
    const hit = state.cache.get(hash);
    if (hit && hit.expires > now) return hit.value;
    const pending = state.inflight.get(hash);
    if (pending) return pending;
  }

  rollDay(now);
  if (kind !== 'paid') return guardedFree(kind, hash, fn, cfg, now, cache);
  const estimate = searches ? cfg.estimateSearchUsd : cfg.estimatePlainUsd;
  const caller = callerStore.getStore()?.caller ?? 'internal';
  const route = callerStore.getStore()?.route ?? '-';
  if (state.lifetimeUsd + estimate > cfg.lifetimeUsd) capHit('the paid-lookup ceiling for this deployment has been reached', caller, route);
  if (state.dayUsd + estimate > cfg.dailyUsd) capHit('the daily paid-lookup budget has been used', caller, route);
  if (state.dayCalls >= cfg.dailyCalls) capHit('the daily paid-lookup call limit has been reached', caller, route);
  checkCaller(now, caller, cfg.hourlyPerCaller, route);

  // Reserve the estimate now so concurrent calls cannot all slip under the cap.
  state.dayUsd += estimate;
  state.lifetimeUsd += estimate;
  state.dayCalls += 1;

  const run = (async () => {
    try {
      const value = await fn();
      const actual = Number(value?.cost_usd);
      note(caller, route, Number.isFinite(actual) ? actual : estimate);
      if (Number.isFinite(actual)) {
        state.dayUsd += actual - estimate;
        state.lifetimeUsd += actual - estimate;
      }
      if (cache && cfg.cacheMs > 0 && value) {
        if (state.cache.size >= MAX_CACHE_ENTRIES) state.cache.delete(state.cache.keys().next().value);
        state.cache.set(hash, { value, expires: Date.now() + cfg.cacheMs });
      }
      return value;
    } catch (err) {
      // A failed call is not charged, so give the reservation back.
      state.dayUsd -= estimate;
      state.lifetimeUsd -= estimate;
      state.dayCalls -= 1;
      throw err;
    } finally {
      state.inflight.delete(hash);
    }
  })();
  if (cache && cfg.cacheMs > 0) state.inflight.set(hash, run);
  return run;
}

// Providers that cost no dollars: only call caps, a per-caller limit and the
// cache apply. The cache entry is shared with the paid path (same hash space).
async function guardedFree(kind, hash, fn, cfg, now, cache) {
  const caller = callerStore.getStore()?.caller ?? 'internal';
  const route = callerStore.getStore()?.route ?? '-';
  const dayCap = kind === 'tavily' ? cfg.tavilyDailyCalls : cfg.freeDailyCalls;
  const callerCap = kind === 'tavily' ? cfg.tavilyHourlyPerCaller : cfg.freeHourlyPerCaller;
  if (state.kindCalls[kind] >= dayCap) capHit(`the daily ${kind} call limit has been reached`, caller, route);
  checkCaller(now, `${kind}:${caller}`, callerCap, route);
  state.kindCalls[kind] += 1;
  const run = (async () => {
    try {
      const value = await fn();
      note(caller, `${route}[${kind}]`, 0);
      if (cache && cfg.cacheMs > 0 && value) {
        if (state.cache.size >= MAX_CACHE_ENTRIES) state.cache.delete(state.cache.keys().next().value);
        state.cache.set(hash, { value, expires: Date.now() + cfg.cacheMs });
      }
      return value;
    } catch (err) {
      state.kindCalls[kind] -= 1;
      throw err;
    } finally {
      state.inflight.delete(hash);
    }
  })();
  if (cache && cfg.cacheMs > 0) state.inflight.set(hash, run);
  return run;
}

export function spendStatus() {
  const cfg = limits();
  rollDay(Date.now());
  return {
    day_usd: Number(state.dayUsd.toFixed(4)),
    day_usd_cap: cfg.dailyUsd,
    day_calls: state.dayCalls,
    day_calls_cap: cfg.dailyCalls,
    lifetime_usd: Number(state.lifetimeUsd.toFixed(4)),
    lifetime_usd_cap: cfg.lifetimeUsd,
    free_calls: state.kindCalls.free,
    tavily_calls: state.kindCalls.tavily,
    cached: state.cache.size,
  };
}
