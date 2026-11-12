// JSON-RPC client for the small set of raw eth_* calls (eth_getCode,
// eth_call, eth_getStorageAt) that Ankr's Advanced API plan on this
// account does not support via its /multichain/{key} endpoint (see
// config.js publicRpcUrl comment). Deliberately separate from
// ankrClient.js: no shared rate limiter, budget, or cache, because this
// only ever backs contractControlRisk.js/liveSolvencyRisk.js's bounded
// 1-3 calls per assessment, not the high-volume paginated scans
// ankrClient.js exists to protect. A node being briefly unavailable
// should degrade that one signal, not the whole request, so callers are
// expected to catch and treat a failure as "skip this check," not
// propagate it.
//
// Tries config.ankrChainRpcUrl first when set (Ankr's per-chain endpoint,
// same paid/authenticated key as everything else in this project --
// confirmed to serve these methods, see config.js comment), then falls
// back to the free public node. An explicit opts.url (tests) skips this
// fallback list entirely and calls only that one URL.

import { config } from '../../config.js';
import { publicRpcUrlsForChain } from '../chains.js';

async function fetchOnce(url, method, params, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`public RPC HTTP ${res.status}`);
    }
    const body = await res.json();
    if (body.error) {
      throw new Error(`public RPC error: ${body.error.message ?? JSON.stringify(body.error)}`);
    }
    if (!Object.hasOwn(body, 'result')) {
      throw new Error('public RPC response missing result');
    }
    return body.result;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * @param {string} method
 * @param {unknown[]} params
 * @param {{ timeoutMs?: number, deadlineAt?: number, signal?: AbortSignal, url?: string, chain?: string }} [opts]
 * @returns {Promise<unknown>}
 */
export async function callPublicRpc(method, params, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadlineAt = opts.deadlineAt ?? Date.now() + timeoutMs;
  const urls = publicRpcUrlsForChain(opts.chain ?? 'eth', opts.url);

  let lastErr;
  for (const url of urls) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new Error('public RPC request aborted');
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw lastErr ?? new Error('public RPC deadline exceeded');
    }
    try {
      return await fetchOnce(url, method, params, Math.min(timeoutMs, remainingMs), opts.signal);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
