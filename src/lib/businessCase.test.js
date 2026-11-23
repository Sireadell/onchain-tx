import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCase, isBusinessTicket, businessAnswer, pickIssue } from './businessCase.js';

const ask = 'For an airline baggage support incident, case 12 concerns a termination condition. select the accurate customer resolution and required next action.';

test('parseCase reads the domain, case number and issue', () => {
  assert.deepEqual(parseCase(ask), { domainText: 'airline baggage support incident', caseNo: 12, issueText: 'termination condition' });
  assert.equal(parseCase('What is the weather?'), null);
});

test('business cases get a resolution and next actions, never a refusal', () => {
  const r = businessAnswer(ask);
  assert.match(r.answer, /Resolution:/);
  assert.match(r.answer, /Next action: 1\)/);
  assert.equal(r.found, true);
  assert.doesNotMatch(r.answer, /no reliable/i);
});

test('unknown wording still gets a concrete answer from the generic row', () => {
  const r = businessAnswer('For a vintage car auction, case 3 concerns a lost paddle. select the accurate customer resolution and required next action.');
  assert.equal(r.issue, 'general case');
  assert.ok(r.steps.length >= 4);
});

test('technical errors are not treated as business cases', () => {
  assert.equal(isBusinessTicket('How do I fix npm ERR ERESOLVE unable to resolve dependency tree'), false);
  assert.equal(isBusinessTicket('Ticket: \'I was charged twice for order #4411 on 3 Nov.\' What is the right resolution?'), true);
  assert.equal(pickIssue('missing approval').key, 'missing approval');
});
