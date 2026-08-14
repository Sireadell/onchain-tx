import { test } from 'node:test';
import assert from 'node:assert/strict';

// Each test dynamically imports a fresh module instance (cache-busted via a
// unique query string) because ankrRpc.js reads its tunables (MAX_RPC_ATTEMPTS,
// ANKR_CALL_TIMEOUT_MS, etc.) from process.env at module-load time — same
// pattern the module itself inherits from walletActivity.js. ANKR_API_KEY is
// also read per-call (not just at load), so env overrides must stay in place
// for the whole test, not just the import — callers restore via t.after().
function freshModule(t, envOverrides = {}) {
  const original = { ...process.env };
  Object.assign(process.env, { ANKR_API_KEY: 'test-key', CHAIN: 'eth', ...envOverrides });
  t.after(() => {
    process.env = original;
  });
  return import(`./ankrRpc.js?case=${Math.random()}`);
}

test('9. non-retryable failure throws immediately, no retry delay', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let callCount = 0;
  globalThis.fetch = async () => {
    callCount += 1;
    return { ok: false, status: 400, statusText: 'Bad Request', json: async () => ({}) };
  };

  const { getTransactionByHash } = await freshModule(t);
  const start = Date.now();
  await assert.rejects(() => getTransactionByHash('eth', '0x' + '1'.repeat(64)));
  assert.equal(callCount, 1, 'a non-retryable 400 must not be retried');
  assert.ok(Date.now() - start < 500, 'must fail fast, no backoff delay for non-retryable errors');
});

test('9/10. retryable failure (rate-limit style 429) combined with RPC budget exhaustion', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) });

  const { getTransactionByHash, RpcBudgetExceededError, withRpcBudget } = await freshModule(t, { MAX_RPC_ATTEMPTS: '1' });
  await assert.rejects(() => withRpcBudget(() => getTransactionByHash('eth', '0x' + '2'.repeat(64))), (err) => {
    assert.ok(err instanceof RpcBudgetExceededError, `expected RpcBudgetExceededError, got ${err}`);
    return true;
  });
});

test('successful call returns the JSON-RPC result', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: { hash: '0xabc' } }),
  });

  const { getTransactionByHash } = await freshModule(t);
  const result = await getTransactionByHash('eth', '0x' + '3'.repeat(64));
  assert.deepEqual(result, { hash: '0xabc' });
});

test('cache is scoped per chain — same tx hash on two chains does not collide', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let callCount = 0;
  globalThis.fetch = async (url) => {
    callCount += 1;
    const chain = url.split('/')[3];
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { hash: '0xabc', chain } }),
    };
  };

  const { getTransactionByHash } = await freshModule(t);
  const hash = '0x' + '5'.repeat(64);
  const ethResult = await getTransactionByHash('eth', hash);
  const baseResult = await getTransactionByHash('base', hash);
  assert.equal(callCount, 2, 'different chains for the same hash must not share a cache entry');
  assert.equal(ethResult.chain, 'eth');
  assert.equal(baseResult.chain, 'base');
});

test('missing ANKR_API_KEY throws ApiKeyMissingError before any network call', async (t) => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const original = { ...process.env };
  delete process.env.ANKR_API_KEY;
  t.after(() => {
    process.env = original;
  });
  const mod = await import(`./ankrRpc.js?case=${Math.random()}`);

  await assert.rejects(() => mod.getTransactionByHash('eth', '0x' + '4'.repeat(64)), mod.ApiKeyMissingError);
  assert.equal(called, false);
});
