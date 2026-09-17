import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenName, getSdnList, prefetchSdnList, __resetSanctionsCacheForTesting } from './sanctionsScreening.js';

const SAMPLE_CSV = [
  '1,"DOE, John","individual","SDGT","Businessman","-0-","-0-","-0-","-0-","-0-","-0-","Aliases: JOHNNY DOE"',
  '2,"ACME EXPORTS LTD","entity","CUBA","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"',
].join('\n');

function stubOfac(t, { delayMs = 0, status = 200, body = SAMPLE_CSV } = {}) {
  __resetSanctionsCacheForTesting();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://www.treasury.gov')) {
      calls += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return new Response(body, { status, headers: { 'Content-Type': 'text/csv' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __resetSanctionsCacheForTesting(); });
  return () => calls;
}

// The real bug (2026-09-17 live replay): a caller-facing call blocked on the
// OFAC feed's own network fetch, which measured live between 5s and 41s and
// once outlasted a 35s client timeout entirely. Once a cache exists, a live
// call must never wait on the network again, only ever read what is cached
// and, if stale, kick a refresh off in the background.
test('getSdnList serves a stale cache instantly instead of waiting on a slow refetch', async (t) => {
  const callCount = stubOfac(t, { delayMs: 200 });
  const first = await getSdnList();
  assert.equal(first.length, 2);
  assert.equal(callCount(), 1);

  // Force the cache to read as expired without waiting out the real TTL.
  const { __setSanctionsCacheAgeForTesting } = await import('./sanctionsScreening.js');
  __setSanctionsCacheAgeForTesting(Date.now() - 7 * 60 * 60 * 1000);

  const t0 = Date.now();
  const second = await getSdnList();
  const elapsed = Date.now() - t0;
  assert.equal(second.length, 2, 'a stale cache is still returned, not an empty result while refreshing');
  assert.ok(elapsed < 50, `stale cache must return immediately, took ${elapsed}ms`);
});

test('getSdnList with no cache yet genuinely waits on the one real request', async (t) => {
  stubOfac(t, { delayMs: 50 });
  const t0 = Date.now();
  const entries = await getSdnList();
  assert.equal(entries.length, 2);
  assert.ok(Date.now() - t0 >= 50, 'a cold cache has nothing to fall back on and must wait for the real fetch');
});

test('concurrent cold-start calls share one in-flight request, not one each', async (t) => {
  const callCount = stubOfac(t, { delayMs: 30 });
  const [a, b, c] = await Promise.all([getSdnList(), getSdnList(), getSdnList()]);
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(callCount(), 1, 'three simultaneous cold-start callers must trigger exactly one network request');
});

test('prefetchSdnList warms the cache without throwing on failure', async (t) => {
  stubOfac(t, { status: 500, body: 'down' });
  prefetchSdnList();
  await new Promise((r) => setTimeout(r, 20));
  // No assertion beyond "did not throw" / "did not crash the process":
  // prefetchSdnList is fire-and-forget by design (called at server startup,
  // never awaited), so a failed warm-up must be silent.
  assert.ok(true);
});

test('screenName still finds a real match through the cache path', async (t) => {
  stubOfac(t);
  const result = await screenName('John Doe');
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].name, 'DOE, John');
});
