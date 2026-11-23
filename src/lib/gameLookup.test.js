import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, romanToInt, detectFinal, mentionsIn, describeGame } from './gameLookup.js';
import { normName } from './espnScores.js';

test('parseDate reads ISO, day-month-year and month-day-year forms', () => {
  assert.equal(parseDate('on 2025-05-10, who won'), '2025-05-10');
  assert.equal(parseDate('22 September 2026?'), '2026-09-22');
  assert.equal(parseDate('March 3, 2025'), '2025-03-03');
  assert.equal(parseDate('no date here'), null);
});

test('romanToInt and detectFinal read Super Bowl numerals and series games', () => {
  assert.equal(romanToInt('LVII'), 57);
  assert.equal(detectFinal('Who won Super Bowl LVIII?').year, 2024);
  const ws = detectFinal('2023 World Series Game 7');
  assert.equal(ws.league, 'mlb');
  assert.equal(ws.game, 7);
  assert.equal(detectFinal('Yankees game'), null);
});

test('mentionsIn finds teams by full name or nickname and ignores shared place names', () => {
  const mk = (name, ...more) => ({ id: name, name, aliases: [name, ...more].map(normName) });
  const teams = [mk('Chicago Cubs', 'Cubs', 'Chicago', 'CHC'), mk('Chicago White Sox', 'White Sox', 'Chicago', 'CHW'), mk('Boston Red Sox', 'Red Sox', 'Boston', 'BOS')];
  const found = mentionsIn(normName('Did the Cubs beat Boston on Friday'), teams).map((x) => x.team.name);
  assert.deepEqual(found, ['Chicago Cubs', 'Boston Red Sox']);
});

test('describeGame states a winner, a draw, a live game and a future game plainly', () => {
  const base = { day: '2025-01-01', competition: 'MLB', note: null, venue: null, home_team: 'A', away_team: 'B', detail: 'Top 3rd' };
  assert.match(describeGame({ ...base, state: 'post', completed: true, home_score: 3, away_score: 1, winner: 'A' }).line, /Winner: A\. A beat B 3-1/);
  assert.match(describeGame({ ...base, state: 'post', completed: true, home_score: 1, away_score: 1, winner: null }).line, /drew 1-1/);
  assert.match(describeGame({ ...base, state: 'in', home_score: 1, away_score: 0 }).line, /not final/);
  assert.match(describeGame({ ...base, state: 'pre', home_score: null, away_score: null }).line, /not been played yet/);
});
