import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSla, readPeriod, readResolutionLimit, parseWindow, overlapMinutes, findProvider } from './statusPageSla.js';

const NOW = Date.UTC(2026, 10, 24, 12);

test('reads the period the question names', () => {
  assert.equal(readPeriod('over the last 90 days', NOW).label, 'the last 90 days');
  const q = readPeriod('during Q3 2023', NOW);
  assert.equal(new Date(q.start).toISOString().slice(0, 10), '2023-07-01');
  assert.equal(new Date(q.end).toISOString().slice(0, 10), '2023-10-01');
  const r = readPeriod('for the period 2026-10-01 to 2026-10-31', NOW);
  assert.equal(new Date(r.end).toISOString().slice(0, 10), '2026-11-01');
  const w = readPeriod('the first two weeks of May 2023', NOW);
  assert.equal(new Date(w.end).toISOString().slice(0, 10), '2023-05-15');
});

test('reads a resolution limit', () => {
  assert.equal(readResolutionLimit('were P1 incidents resolved within the 2-hour SLA?'), 7200000);
  assert.equal(readResolutionLimit('did it meet the 99.95% uptime SLA?'), null);
});

test('parses status page time windows, including ones that cross midnight', () => {
  const w = parseWindow("Feb <var data-var='date'>27</var>, <var data-var='time'>23:10</var> - <var data-var='time'>01:05</var> UTC", 2025, 1);
  assert.equal(w.end - w.start, 115 * 60000);
});

test('counts overlapping outages once', () => {
  const inc = [
    { impact: 'major', start: '2026-01-01T00:00:00Z', end: '2026-01-01T02:00:00Z' },
    { impact: 'critical', start: '2026-01-01T01:00:00Z', end: '2026-01-01T03:00:00Z' },
  ];
  assert.equal(overlapMinutes(inc, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2)), 180);
});

test('knows GitHub from a component name alone', () => {
  assert.equal(findProvider("For the 'Git Operations' component, did we achieve 99.95%")?.name, 'GitHub');
  assert.equal(findProvider('Did the order_processing service meet 99.95%'), null);
});

test('builds a verdict from the published history', async () => {
  const fetchJson = async () => ({
    months: [{
      name: 'November', year: 2026,
      incidents: [{ code: 'a', name: 'Incident with Actions', message: '', impact: 'major', timestamp: 'Nov <var>10</var>, <var>10:00</var> - <var>12:00</var> UTC' }],
    }],
  });
  const r = await checkSla('Did GitHub Actions meet its 99.95% uptime SLA for the last 30 days?', { now: NOW, fetchJson });
  assert.equal(r.verdict, 'Breached');
  assert.equal(r.downtime_minutes, 120);
  assert.match(r.answer, /^Breached\. GitHub Actions uptime/);
});
