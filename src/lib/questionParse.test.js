import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandCountryAbbreviation, locationCandidates, parseWhen, parseCalendarDate, splitTrailingRegion } from './questionParse.js';

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

// A live storm alert on 2026-09-07 asked about "London, UK" and was answered
// for Uk, Irkutsk Oblast, Russia. The geocoder matches nothing for the whole
// string, so the next candidate was the bare "UK", which it happily resolved
// to a Siberian village. The city and the spelled-out country must both be
// tried before any bare abbreviation is.
test('locationCandidates: a "City, ABBREV" place beats the bare abbreviation', () => {
  const candidates = locationCandidates('London, UK');
  assert.equal(candidates[0], 'London, UK');
  assert.ok(candidates.includes('London, United Kingdom'));
  assert.ok(
    candidates.indexOf('London') < candidates.indexOf('UK'),
    'the city must be tried before the bare country abbreviation',
  );
  for (const [input, expected] of [
    ['Miami, US', 'Miami, United States'],
    ['Toronto, CA', 'Toronto, Canada'],
    ['Auckland, NZ', 'Auckland, New Zealand'],
  ]) {
    assert.ok(locationCandidates(input).includes(expected), `${input} -> ${expected}`);
  }
});

test('locationCandidates: a bare country abbreviation leads with the full name', () => {
  const candidates = locationCandidates('UK');
  assert.equal(candidates[0], 'United Kingdom');
});

test('expandCountryAbbreviation: leaves anything it does not recognise alone', () => {
  assert.equal(expandCountryAbbreviation('London, England'), null);
  assert.equal(expandCountryAbbreviation('Wellington'), null);
  assert.equal(expandCountryAbbreviation(''), null);
  assert.equal(expandCountryAbbreviation(null), null);
});

// The prepositional match latches onto the "over" in "beijing over the next
// 48 hours" and captures only "the next 48 hours", so before this the place
// never appeared as a candidate when it led the string with no preposition.
test('locationCandidates: a place leading its own time window still resolves', () => {
  assert.ok(locationCandidates('beijing over the next 48 hours').includes('beijing'));
  assert.ok(locationCandidates('Miami over the next 24 hours').includes('Miami'));
});

// A named calendar date must be read as that date. Before 2026-09-10 nothing
// here parsed one, so "when=September 13" fell through to the route's default
// 3-day window and Dubai was answered for the 10th to the 12th: a window that
// does not contain the day the caller asked about.
const NOW = new Date('2026-09-10T08:00:00Z');

test('a named calendar date is read as that day, not as the default window', () => {
  assert.deepEqual(parseCalendarDate('September 13', NOW), {
    label: 'September 13',
    date: '2026-09-13',
    startDay: 3,
    days: 1,
    hours: 96,
  });
});

test('"by <date>" covers today through that date, so the date asked about is in the window', () => {
  const parsed = parseCalendarDate('Will Dubai reach 45C by September 13?', NOW);
  assert.equal(parsed.startDay, 0);
  assert.equal(parsed.days, 4);
  assert.equal(parsed.date, '2026-09-13');
});

test('day-first and abbreviated month spellings parse the same way', () => {
  for (const text of ['on 13 September', 'Sept 13', '13th of September']) {
    assert.equal(parseCalendarDate(text, NOW).date, '2026-09-13', text);
  }
});

test('a bare date already past this year rolls to next year rather than going negative', () => {
  assert.equal(parseCalendarDate('January 5', NOW).date, '2027-01-05');
});

test('a date beyond forecast range is flagged rather than silently answered', () => {
  const parsed = parseCalendarDate('December 25', NOW);
  assert.equal(parsed.outOfRange, true);
  assert.ok(parsed.startDay > 15);
});

test('an impossible date is refused instead of rolling into the next month', () => {
  assert.equal(parseCalendarDate('February 31', NOW), null);
});

test('parseWhen prefers a named date over the vaguer phrases', () => {
  assert.equal(parseWhen('what is the forecast for September 13').date, '2026-09-13');
});

// "Lagos Nigeria" with no comma resolved to the country centroid, and the
// lowercase form was refused outright, while "Lagos, Nigeria" worked. A comma
// the caller had no reason to supply decided whether the answer was right.
test('a city and country written without a comma yields the comma form first', () => {
  assert.deepEqual(splitTrailingRegion('Lagos Nigeria'), ['Lagos, Nigeria', 'Lagos']);
});

test('the comma-less city beats the bare country in candidate order', () => {
  const candidates = locationCandidates('Lagos Nigeria');
  assert.ok(candidates.indexOf('Lagos, Nigeria') < candidates.indexOf('Nigeria'));
});

test('a lowercase city and country still produces a usable candidate', () => {
  assert.ok(locationCandidates('lagos nigeria').includes('lagos, nigeria'));
});

test('multiword regions and US states split at the right place', () => {
  assert.deepEqual(splitTrailingRegion('Auckland New Zealand'), ['Auckland, New Zealand', 'Auckland']);
  assert.deepEqual(splitTrailingRegion('Houston Texas'), ['Houston, Texas', 'Houston']);
});

test('a bare region name is not split into a city and itself', () => {
  assert.deepEqual(splitTrailingRegion('Nigeria'), []);
  assert.deepEqual(splitTrailingRegion('Singapore'), []);
});
