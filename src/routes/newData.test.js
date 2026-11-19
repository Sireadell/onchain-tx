import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pastDateFromText, socialTerms } from './newData.js';

test('air quality: a past day in the question is read as that date', () => {
  const today = new Date('2026-11-12T00:00:00Z');
  assert.equal(pastDateFromText('average PM2.5 in Los Angeles on October 26, 2023?', today), '2023-10-26');
  assert.equal(pastDateFromText('yesterday, July 25th, 2024', today), '2024-07-25');
  assert.equal(pastDateFromText('current AQI in Paris', today), null);
});

test('twitter search: filler words are dropped from the search terms', () => {
  assert.equal(socialTerms('latest tweets about the upcoming solar eclipse on April 8, 2024'), 'solar eclipse April 8 2024');
  // Real scorer questions that used to search "What are discussions ..."
  assert.equal(socialTerms('What are the latest discussions on X about the upcoming SpaceX Starship launch?'), 'SpaceX Starship launch');
  assert.equal(socialTerms('What are people tweeting about the upcoming Super Bowl LVIII on X?'), 'Super Bowl LVIII');
  assert.equal(socialTerms('What are the latest reactions on X/Twitter regarding the upcoming SpaceX Starship test flight?'), 'SpaceX Starship test flight');
  assert.equal(socialTerms('What are the latest discussions about the upcoming Apple event on X?'), 'Apple event');
  assert.equal(socialTerms('#bitcoin'), '#bitcoin');
});

test('twitter search: only posts naming the subject are kept, closest first', async () => {
  const { socialSubject, onTopic, socialRelevance } = await import('./newData.js');
  const s = socialSubject('What are the latest discussions on X about the upcoming SpaceX Starship launch?');
  assert.deepEqual(s.named, ['SpaceX', 'Starship']);
  assert.equal(onTopic('SpaceX caught a Starship upper stage in the tower', s), true);
  assert.equal(onTopic('I encourage people to post more about what the people who are paying Hakeem Jeffries do', s), false);
  const apple = socialSubject('What are the latest discussions about the upcoming Apple event on X?');
  assert.ok(socialRelevance('Apple event was everything', apple) > socialRelevance('Apple Music is great', apple));
  assert.equal(onTopic('Pineapple pizza', apple), false);
  const eclipse = socialSubject('What are people tweeting about the upcoming solar eclipse on April 8, 2024?');
  assert.deepEqual(eclipse.core, ['solar', 'eclipse']);
});

test('air quality context compares readings with the WHO 24-hour guidelines', async () => {
  const { whoContext } = await import('./newData.js');
  const text = whoContext(30, 20, 25);
  assert.match(text, /PM2\.5 at 30 ug\/m3 is 2\.0 times the WHO 24-hour guideline of 15 ug\/m3/);
  assert.match(text, /PM10 at 20 ug\/m3 is within the WHO 24-hour guideline of 45 ug\/m3/);
  assert.match(text, /NO2 at 25 ug\/m3 is within/);
  assert.equal(whoContext(null, undefined, 0), '');
});
