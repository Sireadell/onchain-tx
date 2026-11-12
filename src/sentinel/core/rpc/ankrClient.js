// Bounded RPC transport layer: Ankr Advanced API client.
//
// Ported from telegraph-forensics-miner's src/lib/walletActivity.js
// (2026-08-10 through 2026-08-14 iterations), transport concerns only.
// The old file mixed transport (retry/rate-limit/budget/cache) with
// wallet-specific signal logic (getEarliestFunder, funder-walking) in one
// module. This file keeps ONLY the transport primitives, generic and
// reusable across any signal. Signal-specific pagination/walking logic
// belongs in src/core/signals/*, not here, and each signal module is
// responsible for choosing its OWN bounded page cap (see
// docs/LOCKED_SPEC.md; no signal should default to the old project's
// generous unbounded-feeling caps, e.g. circularFunding.js's MAX_PAGES=25).
//
// Kept from the old implementation because these are real,
// live-validated transport concerns independent of any detection signal:
//   - token-bucket rate limiter (Ankr Freemium: 50 req/min/key, confirmed
//     live against ankr.com/docs/rpc-service/service-plans/)
//   - retry/backoff with jitter on 429/5xx/timeout
//   - per-request RPC budget guard (attempts plus wall-clock deadline)
//   - run-scoped in-process response cache (TTL-bound)
//
// NOT yet ported: the diagnostic call-log/phase-tagging instrumentation
// from the old file. Useful, but it's an observability nice-to-have, not
// a boundary-establishing piece. Add back later if/when signal work
// needs that visibility.

import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config.js';

export class ApiKeyMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiKeyMissingError';
  }
}

export class RpcBudgetExceededError extends Error {
  constructor(reason) {
    super(`RPC budget exceeded: ${reason}`);
    this.name = 'RpcBudgetExceededError';
    this.reason = reason;
  }
}

function requireApiKey() {
  if (!config.ankrApiKey) {
    throw new ApiKeyMissingError(
      'ANKR_API_KEY not set. Get a free one at ankr.com/rpc/advanced-api.'
    );
  }
  return config.ankrApiKey;
}

// --- Per-request RPC budget guard -----------------------------------------
// Each assessment request gets its own attempt count plus wall-clock
// deadline, scoped via AsyncLocalStorage so it doesn't need to be
// threaded through every call site by hand. Deadline should be set from
// config.hardCutoffMs by the route handler, not hardcoded here.

const MAX_RPC_ATTEMPTS = config.maxRpcAttempts;

const budgetContext = new AsyncLocalStorage();

function budgetError(reason = 'max analysis time exceeded') {
  return new RpcBudgetExceededError(reason);
}

function currentBudget() {
  return budgetContext.getStore();
}

function abortBudget(budget, reason) {
  const error = reason instanceof RpcBudgetExceededError ? reason : budgetError(reason);
  if (budget && !budget.signal.aborted) budget.controller.abort(error);
  return error;
}

function abortedBudgetError(budget) {
  return budget?.signal.reason instanceof RpcBudgetExceededError
    ? budget.signal.reason
    : budgetError('max analysis time exceeded');
}

export async function withRpcBudget(deadlineMs, fn) {
  const controller = new AbortController();
  const budget = {
    attemptsUsed: 0,
    deadlineAt: Date.now() + deadlineMs,
    controller,
    signal: controller.signal,
  };
  const timer = setTimeout(
    () => abortBudget(budget, 'max analysis time exceeded'),
    Math.max(0, deadlineMs)
  );
  const deadline = new Promise((_, reject) => {
    budget.signal.addEventListener('abort', () => reject(abortedBudgetError(budget)), { once: true });
  });
  const work = budgetContext.run(budget, () => Promise.resolve().then(fn));
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function checkBudget() {
  const budget = currentBudget();
  if (!budget) return; // no active budget (e.g. a script/test run), unbounded
  if (budget.signal.aborted) throw abortedBudgetError(budget);
  if (Date.now() >= budget.deadlineAt) {
    throw abortBudget(budget, 'max analysis time exceeded');
  }
  if (budget.attemptsUsed >= MAX_RPC_ATTEMPTS) {
    throw abortBudget(budget, 'max RPC attempts exceeded');
  }
  budget.attemptsUsed += 1;
}

export function assertRpcBudgetAvailable() {
  const budget = currentBudget();
  if (!budget) return;
  if (budget.signal.aborted || Date.now() >= budget.deadlineAt) {
    throw abortBudget(budget, 'max analysis time exceeded');
  }
}

function waitWithBudget(delayMs) {
  const budget = currentBudget();
  if (!budget) return new Promise((resolve) => setTimeout(resolve, delayMs));
  assertRpcBudgetAvailable();
  const remaining = budget.deadlineAt - Date.now();
  return new Promise((resolve, reject) => {
    const finish = (callback) => {
      budget.signal.removeEventListener('abort', onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), Math.min(delayMs, Math.max(0, remaining)));
    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(abortedBudgetError(budget)));
    };
    budget.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      if (budget.signal.aborted) onAbort();
    });
  }).then(() => assertRpcBudgetAvailable());
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error('operation aborted'), { name: 'AbortError' }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('operation aborted'), { name: 'AbortError' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

// --- Rate limiter (token bucket) -------------------------------------------
// Shared token bucket across the whole process, not just one request's
// budget above. Frozen production value is ANKR_RATE_LIMIT_PER_MIN=120
// (Ankr Premium PAYG plan), set via config/.env/render.yaml, not this
// module. The in-code fallback below (40) only applies if that env var is
// left unset; it intentionally stays conservative rather than assuming
// Premium, see config.js for the documented default.

const RATE_LIMIT_PER_MIN = config.ankrRateLimitPerMin;
const RATE_LIMIT_BURST = config.ankrRateLimitBurst;
const REFILL_MS_PER_TOKEN = 60_000 / RATE_LIMIT_PER_MIN;

let tokens = RATE_LIMIT_BURST;
let lastRefillAt = Date.now();
let rateLimitQueue = Promise.resolve();

function refillTokens() {
  const now = Date.now();
  const elapsed = now - lastRefillAt;
  const newTokens = Math.floor(elapsed / REFILL_MS_PER_TOKEN);
  if (newTokens > 0) {
    tokens = Math.min(RATE_LIMIT_BURST, tokens + newTokens);
    lastRefillAt += newTokens * REFILL_MS_PER_TOKEN;
  }
}

function waitForRateLimitSlot() {
  const budget = currentBudget();
  const claim = rateLimitQueue.then(async () => {
    for (;;) {
      if (budget) assertRpcBudgetAvailable();
      refillTokens();
      if (tokens > 0) {
        tokens -= 1;
        return;
      }
      await waitWithBudget(Math.max(10, REFILL_MS_PER_TOKEN - (Date.now() - lastRefillAt)));
    }
  });
  rateLimitQueue = claim.catch(() => {});
  return claim;
}

// --- Retry policy ------------------------------------------------------

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function isRetryableFailure(statusCode, errName) {
  if (errName === 'AbortError') return true;
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500) return true;
  return false;
}

// --- Run-scoped response cache ------------------------------------------

const CACHE_TTL_MS = config.rpcCacheTtlMs;
const MAX_CACHE_ENTRIES = 2_000;
const cache = new Map();

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cacheKey(method, paramsKey, params) {
  return `${method}:${paramsKey}:${stableSerialize(params)}`;
}

async function cachedFetch(method, paramsKey, params, fetcher, trace) {
  const key = cacheKey(method, paramsKey, params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
    trace?.({ type: 'cache_hit' });
    return hit.value;
  }
  const value = await fetcher();
  cache.set(key, { value, storedAt: Date.now() });
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value); // evict oldest
  }
  return value;
}

export function resetRpcCache() {
  cache.clear();
}

export function setRateLimitStateForTests(nextTokens, nextLastRefillAt = Date.now()) {
  tokens = nextTokens;
  lastRefillAt = nextLastRefillAt;
  rateLimitQueue = Promise.resolve();
}

// --- Core fetch ----------------------------------------------------------

async function fetchAnkr(method, params, trace) {
  const apiKey = requireApiKey();

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    checkBudget();
    const rateLimitStartedAt = performance.now();
    try {
      await waitForRateLimitSlot();
      trace?.({
        type: 'rate_limit_wait',
        attemptNumber: attempt + 1,
        retryNumber: attempt,
        intervalStartedAt: rateLimitStartedAt,
        intervalEndedAt: performance.now(),
        elapsedMs: performance.now() - rateLimitStartedAt,
        succeeded: true,
      });
    } catch (error) {
      trace?.({
        type: 'rate_limit_wait',
        attemptNumber: attempt + 1,
        retryNumber: attempt,
        intervalStartedAt: rateLimitStartedAt,
        intervalEndedAt: performance.now(),
        elapsedMs: performance.now() - rateLimitStartedAt,
        succeeded: false,
        errorName: error.name,
      });
      throw error;
    }
    assertRpcBudgetAvailable();

    const controller = new AbortController();
    const budget = currentBudget();
    let callTimedOut = false;
    const onBudgetAbort = () => controller.abort();
    budget?.signal.addEventListener('abort', onBudgetAbort, { once: true });
    const timer = setTimeout(() => {
      callTimedOut = true;
      controller.abort();
    }, config.ankrCallTimeoutMs);
    let res;
    let networkErr;
    const fetchStartedAt = performance.now();
    trace?.({
      type: 'provider_attempt_start',
      attemptNumber: attempt + 1,
      retryNumber: attempt,
      intervalStartedAt: fetchStartedAt,
    });
    try {
      res = await raceWithSignal(
        fetch(`https://rpc.ankr.com/multichain/${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        }),
        controller.signal
      );
    } catch (err) {
      networkErr = err;
    }
    const fetchElapsedMs = performance.now() - fetchStartedAt;

    const statusCode = res?.status;
    const ok = res?.ok ?? false;
    const errName = networkErr?.name;

    if (ok) {
      let body;
      const bodyStartedAt = performance.now();
      try {
        body = await raceWithSignal(res.json(), controller.signal);
      } catch (err) {
        networkErr = err;
      } finally {
        clearTimeout(timer);
        budget?.signal.removeEventListener('abort', onBudgetAbort);
      }
      if (budget?.signal.aborted) throw abortedBudgetError(budget);
      if (callTimedOut) {
        networkErr ??= Object.assign(new Error('Ankr response body timed out'), { name: 'AbortError' });
      }
      if (networkErr) {
        const retryable = isRetryableFailure(undefined, networkErr.name);
        trace?.({
          type: 'provider_attempt',
          attemptNumber: attempt + 1,
          retryNumber: attempt,
          elapsedMs: fetchElapsedMs,
          bodyElapsedMs: performance.now() - bodyStartedAt,
          succeeded: false,
          retryable,
          statusCode,
          errorName: networkErr.name,
        });
        if (retryable && attempt < RETRY_DELAYS_MS.length) {
          const base = RETRY_DELAYS_MS[attempt];
          await waitWithBudget(base * (0.7 + Math.random() * 0.6));
          continue;
        }
        throw networkErr;
      }
      if (body.error) {
        trace?.({
          type: 'provider_attempt',
          attemptNumber: attempt + 1,
          retryNumber: attempt,
          elapsedMs: fetchElapsedMs,
          bodyElapsedMs: performance.now() - bodyStartedAt,
          succeeded: false,
          retryable: false,
          statusCode,
          providerError: true,
        });
        throw new Error(`Ankr request failed: ${body.error.message ?? JSON.stringify(body.error)}`);
      }
      trace?.({
        type: 'provider_attempt',
        attemptNumber: attempt + 1,
        retryNumber: attempt,
        elapsedMs: fetchElapsedMs,
        bodyElapsedMs: performance.now() - bodyStartedAt,
        succeeded: true,
        retryable: false,
        statusCode,
      });
      return body.result;
    }

    clearTimeout(timer);
    budget?.signal.removeEventListener('abort', onBudgetAbort);
    if (budget?.signal.aborted) throw abortedBudgetError(budget);

    const retryable = isRetryableFailure(statusCode, errName);
    const attemptsLeft = attempt < RETRY_DELAYS_MS.length;
    trace?.({
      type: 'provider_attempt',
      attemptNumber: attempt + 1,
      retryNumber: attempt,
      elapsedMs: fetchElapsedMs,
      succeeded: false,
      retryable,
      statusCode,
      errorName: errName,
    });
    if (!retryable || !attemptsLeft) {
      if (errName === 'AbortError') {
        throw new Error(`Ankr request timed out after ${config.ankrCallTimeoutMs}ms (${attempt + 1} attempt(s))`);
      }
      if (networkErr) throw networkErr;
      throw new Error(`Ankr request failed: ${statusCode} ${res?.statusText} (${attempt + 1} attempt(s))`);
    }

    const base = RETRY_DELAYS_MS[attempt];
    const jitteredDelay = base * (0.7 + Math.random() * 0.6); // 70%-130% base
    await waitWithBudget(jitteredDelay);
  }
}

/**
 * Generic bounded RPC call interface. Every Ankr call in every signal
 * module should go through this, never call fetch() directly. Wraps
 * budget check, rate limiting, retry/backoff, and TTL caching.
 *
 * @param {string} method e.g. 'ankr_getTransactionsByAddress'
 * @param {object} params
 * @param {{ cacheKey?: string }} [opts] pass a stable cacheKey (e.g.
 *   `${address}:${pageSize}:${pageToken}`) to enable caching for this call;
 *   omit to bypass the cache.
 */
export async function callAnkr(method, params, opts = {}) {
  const trace = opts.onTrace
    ? (event) => opts.onTrace({ ...opts.trace, method, ...event })
    : undefined;
  if (opts.cacheKey) {
    return cachedFetch(
      method,
      opts.cacheKey,
      params,
      () => fetchAnkr(method, params, trace),
      trace
    );
  }
  return fetchAnkr(method, params, trace);
}
