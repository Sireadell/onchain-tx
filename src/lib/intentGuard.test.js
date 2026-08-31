// Every question below is real. They were pulled from the Telegraph
// dispatcher's own routing log (/api/daemon/api/questions) for the two weeks
// to 2026-08-31, and each one was actually routed to the intent it is listed
// under here. That matters: the guard's whole job is to tell a genuine
// request apart from a misroute on this network specifically, so a
// hand-invented example proves nothing about whether it does that.
//
// The first list is the regression that prompted these tests. The original
// cue list refused all six, which would have thrown away the answerable half
// of every weather question the network sent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isQuestionLike, questionMatchesIntent, WEATHER_CUES, STORM_CUES } from './intentGuard.js';

// Routed to WEATHER_FORECAST and genuinely answerable from a forecast.
const REAL_WEATHER_QUESTIONS = [
  'Will Riyadh see temperatures above 40°C tomorrow?',
  'Will Dubai hit 45°C this week?',
  'Will Cairo hit 40°C tomorrow?',
  'Will Riyadh hit 45°C this week?',
  'Will Dubai hit 40°C tomorrow?',
  'Will Dubai hit 40°C this week?',
  'Will London see heavy rain this weekend?',
  'What is the weather forecast for Tokyo tomorrow?',
];

// Also routed to WEATHER_FORECAST, but a forecast cannot answer any of them.
// Answering anyway is what produced a rainfall report for a question about
// war, which scores zero and reads as broken.
const MISROUTED_TO_WEATHER = [
  'Will El Niño cause global food shortages?',
  'Is total war now in Russia?',
  'Will Penghu troops strike?',
  'Did Niger rebels seize the capital airbase?',
  'Will US Iraq conflict resume before January?',
  'Will Serbia see increased naval activity?',
  'Is Long Grove Pharmaceuticals supply halted?',
  'Will US Patriot missile stocks in Europe drop below critical levels?',
  'Will Black Sea grain exports remain blocked?',
];

for (const question of REAL_WEATHER_QUESTIONS) {
  test(`weather guard admits a real forecast question: ${question}`, () => {
    assert.equal(questionMatchesIntent(question, WEATHER_CUES), true);
  });
}

for (const question of MISROUTED_TO_WEATHER) {
  test(`weather guard refuses a misroute: ${question}`, () => {
    assert.equal(questionMatchesIntent(question, WEATHER_CUES), false);
  });
}

test('the plural of temperature is a cue, not just the singular', () => {
  // The exact bug: \btemperature\b does not match "temperatures", so
  // "Will Riyadh see temperatures above 40C" read as a non-weather question.
  assert.equal(questionMatchesIntent('Will Riyadh see temperatures rise?', WEATHER_CUES), true);
  assert.equal(questionMatchesIntent('Will the temperature rise?', WEATHER_CUES), true);
});

test('a degree reading is a weather cue even with no weather word present', () => {
  assert.equal(questionMatchesIntent('Will Dubai hit 45°C this week?', WEATHER_CUES), true);
  assert.equal(questionMatchesIntent('Will Dubai hit 45 degrees this week?', WEATHER_CUES), true);
});

test('a bare place name is not a question, so it passes untouched', () => {
  // The dispatcher usually sends a location, not a sentence. The guard must
  // never stand between a plain "Lagos" and its forecast.
  assert.equal(isQuestionLike('Lagos'), false);
  assert.equal(questionMatchesIntent('Lagos', WEATHER_CUES), true);
  assert.equal(questionMatchesIntent('6.45,3.39', WEATHER_CUES), true);
  assert.equal(questionMatchesIntent('Makurdi, Nigeria', WEATHER_CUES), true);
});

test('storm guard admits real severe-weather questions', () => {
  assert.equal(questionMatchesIntent('Will Taiwan face more flooding this year?', STORM_CUES), true);
  assert.equal(questionMatchesIntent('Will Nepal glacier collapse trigger major flooding?', STORM_CUES), true);
  assert.equal(questionMatchesIntent('Is a typhoon expected in Manila?', STORM_CUES), true);
});

test('storm guard stays narrower than the forecast guard', () => {
  // /storm-alert grades a 48-hour disruption risk. A seasonal climate
  // question is weather-shaped but still outside what it can answer, so it
  // is refused here while a plain forecast question would be accepted.
  assert.equal(questionMatchesIntent('Will El Niño disrupt Panama Canal traffic?', STORM_CUES), false);
  assert.equal(questionMatchesIntent('Will CAMZYOS get new safety warnings?', STORM_CUES), false);
  assert.equal(questionMatchesIntent('Will the UK government distribute emergency supplies?', STORM_CUES), false);
});
