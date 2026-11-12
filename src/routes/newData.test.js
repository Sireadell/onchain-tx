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
