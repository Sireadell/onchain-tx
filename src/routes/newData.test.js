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
});

test('air quality context compares readings with the WHO 24-hour guidelines', async () => {
  const { whoContext } = await import('./newData.js');
  const text = whoContext(30, 20, 25);
  assert.match(text, /PM2\.5 at 30 ug\/m3 is 2\.0 times the WHO 24-hour guideline of 15 ug\/m3/);
  assert.match(text, /PM10 at 20 ug\/m3 is within the WHO 24-hour guideline of 45 ug\/m3/);
  assert.match(text, /NO2 at 25 ug\/m3 is within/);
  assert.equal(whoContext(null, undefined, 0), '');
});
