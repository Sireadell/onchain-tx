// Standard eth_ JSON-RPC transport via Ankr's per-chain endpoint
// (rpc.ankr.com/{chain}/{key}) — a different Ankr product line from the
// /multichain/{key} Advanced API endpoint used by Miner #1's
// walletActivity.js (that one only serves ankr_-namespaced convenience
// methods, not standard eth_* calls). Confirmed live 2026-08-14 by calling
// eth_getTransactionByHash / eth_getTransactionReceipt against a real
// mainnet tx before this file was written — see BUILD_SPEC.md.
//
// Retry/rate-limit/budget/cache machinery below is ported from
// walletActivity.js — same reasoning, generalized for single-shot
// (method, params) calls instead of paginated address lookups.

import { AsyncLocalStorage } from 'node:async_hooks';

const ANKR_CALL_TIMEOUT_MS = Number(process.env.ANKR_CALL_TIMEOUT_MS) || 8_000;

export class ApiKeyMissingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiKeyMissingError';
  }
}

function requireApiKey() {
  const apiKey = process.env.ANKR_API_KEY;
  if (!apiKey) {
    throw new ApiKeyMissingError(
      'ANKR_API_KEY is not set. Get a free one at ankr.com/rpc/advanced-api.'
    );
  }
  return apiKey;
}

// RPC BUDGET GUARD — same shape as walletActivity.js's, opt-in per call
// tree via withRpcBudget(). A single tx lookup only ever needs at most two
// physical calls (tx + receipt), so these limits exist mainly to bound
// wall-clock time under retries, not attempt count.
const MAX_RPC_ATTEMPTS = Number(process.env.MAX_RPC_ATTEMPTS) || 20;
const MAX_ANALYSIS_TIME_MS = Number(process.env.MAX_ANALYSIS_TIME_MS) || 20_000;

export class RpcBudgetExceededError extends Error {
  constructor(reason) {
    super(`RPC budget exceeded: ${reason}`);
    this.name = 'RpcBudgetExceededError';
    this.reason = reason;
  }
}

const budgetContext = new AsyncLocalStorage();

export function withRpcBudget(fn) {
  return budgetContext.run({ attemptsUsed: 0, deadlineAt: Date.now() + MAX_ANALYSIS_TIME_MS }, fn);
}

export function checkBudget() {
  const budget = budgetContext.getStore();
  if (!budget) return;
  if (Date.now() >= budget.deadlineAt) throw new RpcBudgetExceededError('max analysis time exceeded');
  if (budget.attemptsUsed >= MAX_RPC_ATTEMPTS) throw new RpcBudgetExceededError('max RPC attempts exceeded');
  budget.attemptsUsed += 1;
}

// Retry policy — identical reasoning to walletActivity.js: 429/5xx/timeout
// are transient, worth a bounded retry with backoff + jitter; anything else
// (a valid JSON-RPC error body included) is not retryable.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function isRetryableFailure(statusCode, errName) {
  if (errName === 'AbortError') return true;
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500) return true;
  return false;
}

// RATE LIMITER — same token-bucket approach and default ceiling as
// walletActivity.js (Ankr Freemium plan: 50 req/min/key, kept with margin).
const RATE_LIMIT_PER_MIN = Number(process.env.ANKR_RATE_LIMIT_PER_MIN) || 40;
const RATE_LIMIT_BURST = Number(process.env.ANKR_RATE_LIMIT_BURST) || 10;
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
  const claim = rateLimitQueue.then(async () => {
    for (;;) {
      refillTokens();
      if (tokens > 0) {
        tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.max(10, REFILL_MS_PER_TOKEN - (Date.now() - lastRefillAt))));
    }
  });
  rateLimitQueue = claim.catch(() => {});
  return claim;
}

// RUN-SCOPED CACHE — keyed on (chain, method, ...params) rather than
// (method, address, pageSize, pageToken) like walletActivity.js, since
// there's no pagination here. `chain` is part of the key (not just method
// + params) because eth_blockNumber's params are always `[]` — without the
// chain segment, every chain would collide on one shared cached block
// height, which is a real cross-chain correctness bug, not just an
// inefficiency. A tx lookup and its receipt lookup made twice in the same
// short window (e.g. status + confidence both reading the receipt) hit
// this instead of Ankr twice.
const CACHE_TTL_MS = Number(process.env.RPC_CACHE_TTL_MS) || 30_000;
const MAX_CACHE_ENTRIES = 500;
const cache = new Map();

function cacheKey(chainSegment, method, params) {
  return `${chainSegment}:${method}:${JSON.stringify(params)}`;
}

async function cachedFetch(chainSegment, method, params, fetcher) {
  const key = cacheKey(chainSegment, method, params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) {
    return hit.value;
  }
  const value = await fetcher();
  cache.set(key, { value, storedAt: Date.now() });
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value); // evict oldest (Map preserves insertion order)
  }
  return value;
}

export function resetRpcCache() {
  cache.clear();
}

async function fetchAnkrRpc(chainSegment, method, params) {
  const apiKey = requireApiKey();

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    checkBudget();
    await waitForRateLimitSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANKR_CALL_TIMEOUT_MS);
    let res;
    let ok = true;
    let statusCode;
    let errName;
    let networkErr;
    try {
      res = await fetch(`https://rpc.ankr.com/${chainSegment}/${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      statusCode = res.status;
      ok = res.ok;
    } catch (err) {
      ok = false;
      errName = err.name;
      networkErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (ok) {
      const body = await res.json();
      if (body.error) {
        throw new Error(`Ankr request failed: ${body.error.message ?? JSON.stringify(body.error)}`);
      }
      return body.result;
    }

    const retryable = isRetryableFailure(statusCode, errName);
    const attemptsLeft = attempt < RETRY_DELAYS_MS.length;
    if (!retryable || !attemptsLeft) {
      if (errName === 'AbortError') {
        throw new Error(`Ankr request timed out after ${ANKR_CALL_TIMEOUT_MS}ms (${attempt + 1} attempt(s))`);
      }
      if (networkErr) throw networkErr;
      throw new Error(`Ankr request failed: ${statusCode} ${res.statusText} (${attempt + 1} attempt(s))`);
    }

    const base = RETRY_DELAYS_MS[attempt];
    const jitteredDelay = base * (0.7 + Math.random() * 0.6); // 70%-130% of base
    await new Promise((r) => setTimeout(r, jitteredDelay));
  }
}

export async function getTransactionByHash(chainSegment, txHash) {
  return cachedFetch(chainSegment, 'eth_getTransactionByHash', [txHash], () =>
    fetchAnkrRpc(chainSegment, 'eth_getTransactionByHash', [txHash])
  );
}

export async function getTransactionReceipt(chainSegment, txHash) {
  return cachedFetch(chainSegment, 'eth_getTransactionReceipt', [txHash], () =>
    fetchAnkrRpc(chainSegment, 'eth_getTransactionReceipt', [txHash])
  );
}

export async function getBlockNumber(chainSegment) {
  return cachedFetch(chainSegment, 'eth_blockNumber', [], () => fetchAnkrRpc(chainSegment, 'eth_blockNumber', []));
}

// Short TTL relative to CACHE_TTL_MS's default (30s) — gas price moves
// block-to-block and a stale cached price is a wrong answer, not just a
// slightly-late one, unlike tx/receipt lookups which are immutable once
// mined.
const GAS_PRICE_CACHE_TTL_MS = Number(process.env.GAS_PRICE_CACHE_TTL_MS) || 5_000;

export async function getGasPrice(chainSegment) {
  const key = cacheKey(chainSegment, 'eth_gasPrice', []);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.storedAt < GAS_PRICE_CACHE_TTL_MS) {
    return hit.value;
  }
  const value = await fetchAnkrRpc(chainSegment, 'eth_gasPrice', []);
  cache.set(key, { value, storedAt: Date.now() });
  return value;
}

export async function getBalance(chainSegment, address) {
  return cachedFetch(chainSegment, 'eth_getBalance', [address, 'latest'], () =>
    fetchAnkrRpc(chainSegment, 'eth_getBalance', [address, 'latest'])
  );
}

// ERC-20 balance via eth_call to balanceOf(address) — standard ABI
// function selector 0x70a08231, single left-padded 32-byte address arg.
// Same eth_call params shape as any other JSON-RPC call, so it flows
// through the same cachedFetch/retry/rate-limit/budget machinery as
// getBalance above with no extra plumbing.
export async function getTokenBalance(chainSegment, tokenAddress, walletAddress) {
  const data = `0x70a08231000000000000000000000000${walletAddress.slice(2).toLowerCase()}`;
  const callParams = [{ to: tokenAddress, data }, 'latest'];
  return cachedFetch(chainSegment, 'eth_call_balanceOf', [tokenAddress, walletAddress], () =>
    fetchAnkrRpc(chainSegment, 'eth_call', callParams)
  );
}
