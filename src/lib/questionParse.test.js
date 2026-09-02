import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationCandidates, parseWhen } from './questionParse.js';

test('question parser extracts Tokyo and two calendar days from the hard forecast question', () => {
  const question = "Give Tokyo's high, low, rain, and wind outlook for the next two calendar days.";
  assert.equal(locationCandidates(question)[0], 'Tokyo');
  assert.deepEqual(parseWhen(question), {
    label: 'the next two days',
    startDay: 0,
    days: 2,
    hours: 48,
  });
});

test('question parser extracts Manila and 48 hours from the hard storm question', () => {
  const question = "Assess Manila's next 48 hours for thunderstorm, gust, and flooding disruption risk.";
  assert.equal(locationCandidates(question)[0], 'Manila');
  assert.deepEqual(parseWhen(question), {
    label: 'the next 48 hours',
    startDay: 0,
    days: 2,
    hours: 48,
  });
});

test('question parser keeps complete multiword and punctuated possessive places', () => {
  assert.equal(locationCandidates("What's New York's weather tomorrow?")[0], 'New York');
  assert.equal(locationCandidates("Will St. John's have rain tomorrow?")[0], "St. John's");
  assert.equal(locationCandidates("Will Rio de Janeiro's weather improve tomorrow?")[0], 'Rio de Janeiro');
  assert.equal(locationCandidates("Will King's Lynn's weather improve tomorrow?")[0], "King's Lynn");
});
