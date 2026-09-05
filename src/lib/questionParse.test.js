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

// Live traffic on 2026-09-05 asked for "storm risk in beijing", lowercase,
// and it was refused: the only candidate was the whole phrase including the
// time window, and the capitalised-run match cannot see a lowercase name.
test('locationCandidates: finds a lowercase place before a time window', () => {
  const cases = [
    ['Is there a storm or severe weather risk in beijing over the next 48 hours?', 'beijing'],
    ['weather in new york city over the next 3 days', 'new york city'],
    ['storm risk in osaka for the next 12 hours', 'osaka'],
  ];
  for (const [question, place] of cases) {
    assert.ok(locationCandidates(question).includes(place), `${question} -> ${place}`);
  }
});

test('locationCandidates: places that already resolved still lead with the same candidate', () => {
  assert.equal(locationCandidates('Will it rain in London tomorrow?')[0], 'London');
  assert.equal(locationCandidates('storm risk near Miami this weekend')[0], 'Miami');
  assert.equal(locationCandidates('What is the storm risk in Tokyo over the next 24 hours?')[0], 'Tokyo over the next 24 hours');
});
