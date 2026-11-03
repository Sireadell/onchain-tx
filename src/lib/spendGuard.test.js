import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { guarded, resetSpendGuard, spendStatus, SpendCapError } from './spendGuard.js';

beforeEach(() => {
  process.env.LLM_GUARD_FORCE = '1';
  for (const k of ['LLM_DAILY_USD_CAP', 'LLM_DAILY_CALL_CAP', 'LLM_HOURLY_CALLS_PER_CALLER', 'LLM_LIFETIME_USD_CAP', 'LLM_CACHE_MINUTES']) delete process.env[k];
  resetSpendGuard();
});

test('an identical request is answered from the cache and charged once', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; return { text: 'a', cost_usd: 0.01 }; };
  await guarded('same', fn);
  await guarded('same', fn);
  assert.equal(calls, 1);
  assert.equal(spendStatus().day_calls, 1);
});

test('simultaneous identical requests share one paid call', async () => {
  let calls = 0;
  const fn = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { text: 'a' }; };
  await Promise.all([guarded('burst', fn), guarded('burst', fn), guarded('burst', fn)]);
  assert.equal(calls, 1);
});

test('the daily call cap stops further paid calls', async () => {
  process.env.LLM_DAILY_CALL_CAP = '3';
  process.env.LLM_HOURLY_CALLS_PER_CALLER = '100';
  for (let i = 0; i < 3; i += 1) await guarded(`q${i}`, async () => ({ text: 'x' }));
  await assert.rejects(() => guarded('q-extra', async () => ({ text: 'x' })), SpendCapError);
});

test('the daily dollar cap stops further paid calls', async () => {
  process.env.LLM_DAILY_USD_CAP = '0.03';
  process.env.LLM_HOURLY_CALLS_PER_CALLER = '100';
  await guarded('a', async () => ({ cost_usd: 0.02 }), { searches: true });
  await assert.rejects(() => guarded('b', async () => ({ cost_usd: 0.02 }), { searches: true }), SpendCapError);
});

test('one caller cannot exceed the hourly limit', async () => {
  process.env.LLM_HOURLY_CALLS_PER_CALLER = '2';
  await guarded('1', async () => ({ text: 'x' }));
  await guarded('2', async () => ({ text: 'x' }));
  await assert.rejects(() => guarded('3', async () => ({ text: 'x' })), SpendCapError);
});

test('a failed call is not charged', async () => {
  await assert.rejects(() => guarded('boom', async () => { throw new Error('upstream'); }), /upstream/);
  assert.equal(spendStatus().day_calls, 0);
  assert.equal(spendStatus().day_usd, 0);
});

test('the lifetime ceiling is a hard stop', async () => {
  process.env.LLM_LIFETIME_USD_CAP = '0.01';
  await assert.rejects(() => guarded('x', async () => ({ text: 'x' }), { searches: true }), SpendCapError);
});
