import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historicalDateParam } from './asOfDate.js';

test('asOfDate: reads the date shapes the dispatcher actually sends', () => {
  assert.deepEqual(historicalDateParam({ date: '2023-01-01' }), {
    unixSeconds: 1672531200,
    isoDay: '2023-01-01',
  });
  assert.equal(historicalDateParam({ date: '2024-01-15' }).isoDay, '2024-01-15');
  assert.equal(historicalDateParam({ date: '2023-01-01T00:00:00Z' }).isoDay, '2023-01-01');
  assert.equal(historicalDateParam({ timestamp: 1672531200 }).isoDay, '2023-01-01');
});

test('asOfDate: a written day is read as that calendar day, not local midnight', () => {
  assert.equal(historicalDateParam({ date: 'January 5, 2024' }).isoDay, '2024-01-05');
  assert.equal(historicalDateParam({ date: '5 Jan 2024' }).isoDay, '2024-01-05');
});

test('asOfDate: today, the future and unreadable values keep the current price', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(historicalDateParam({ date: today }), null);
  assert.equal(historicalDateParam({ date: '2099-01-01' }), null);
  assert.equal(historicalDateParam({ date: 'tomorrow' }), null);
  assert.equal(historicalDateParam({ date: '' }), null);
  assert.equal(historicalDateParam({}), null);
  assert.equal(historicalDateParam(null), null);
});

test('asOfDate: a year before anything was priced is not a lookup', () => {
  assert.equal(historicalDateParam({ date: '0001-01-01' }), null);
  assert.equal(historicalDateParam({ date: '1999-06-30' }), null);
});
