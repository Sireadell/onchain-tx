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
import { isQuestionLike, questionMatchesIntent, freeTextMatchesIntent, stockTextMatchesIntent, WEATHER_CUES, STORM_CUES, GAS_CUES, ACADEMIC_CUES } from './intentGuard.js';

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

test('storm guard admits weather alert language without accepting other warning domains', () => {
  assert.equal(questionMatchesIntent('Are there weather alerts for Miami?', STORM_CUES), true);
  assert.equal(questionMatchesIntent('Is Miami under a warning?', STORM_CUES), true);
  assert.equal(questionMatchesIntent('Does this product have a warning?', STORM_CUES), false);
  assert.equal(questionMatchesIntent('Is CAMZYOS under a medical warning?', STORM_CUES), false);
  assert.equal(questionMatchesIntent('Did the government issue a travel advisory?', STORM_CUES), false);
  assert.equal(questionMatchesIntent('Is Apple under an earnings warning?', STORM_CUES), false);
  assert.equal(questionMatchesIntent('The government issued a storm warning', STORM_CUES), true);
  assert.equal(questionMatchesIntent('Public safety flood warning for Miami', STORM_CUES), true);
  assert.equal(freeTextMatchesIntent('Bitcoin is under a warning', STORM_CUES), false);
  assert.equal(freeTextMatchesIntent('My account is under a warning', STORM_CUES), false);
});

// GAS_PRICE, STOCK_PRICE and ACADEMIC_SEARCH questions are too rare in the
// dispatcher's own routing log to sample the way the 46 real weather
// questions were (2026-08-31: 0 GAS_PRICE and 1 STOCK_PRICE question in a
// sample of 900 recent routed questions network-wide). These fixtures are
// hand-written realistic phrasings instead, checked against the same class
// of gap the original weather list had: a genuine question that names the
// thing but not the exact word the old narrower list matched on.
const REAL_STYLE_GAS_QUESTIONS = [
  'How much would it cost me to send ETH on Base right now?',
  'What does it cost to move funds on Polygon?',
  'How expensive is it to transact on Arbitrum today?',
  'What will I pay to send a transaction on Polygon?',
  'How pricey is Ethereum right now for a swap?',
  'What is the current gas price on Ethereum?',
];
for (const question of REAL_STYLE_GAS_QUESTIONS) {
  test(`gas guard admits a realistic gas question: ${question}`, () => {
    assert.equal(questionMatchesIntent(question, GAS_CUES), true);
  });
}

const REAL_STYLE_STOCK_QUESTIONS = [
  'What is NVDA at?',
  'What is AAPL trading at?',
  'What is NVDA price?',
  'What is the price of AAPL?',
  'How much is NVDA?',
  'AAPL today?',
  'Apple price today',
  'How is Apple trading?',
  'How much is TSLA stock worth today?',
  'Is Microsoft stock up or down today?',
  'What is Apple share price right now?',
];
for (const question of REAL_STYLE_STOCK_QUESTIONS) {
  test(`stock guard admits a realistic stock question: ${question}`, () => {
    assert.equal(stockTextMatchesIntent(question), true);
  });
}

const REAL_STYLE_ACADEMIC_QUESTIONS = [
  'What do scholars say about federated learning?',
  'Show me citations on AI safety',
  'Find peer-reviewed work on quantum computing',
  'Find research studies on vaccine hesitancy',
  'Find literature on federated learning',
  'What does the literature say about mRNA vaccines?',
  'Show me publications about CRISPR',
  'Find scientific articles on CRISPR',
  'Find articles on AI safety',
  'Research federated learning',
];
for (const question of REAL_STYLE_ACADEMIC_QUESTIONS) {
  test(`academic guard admits a realistic academic question: ${question}`, () => {
    assert.equal(questionMatchesIntent(question, ACADEMIC_CUES), true);
  });
}

test('widened guards still reject obvious cross-intent and unrelated wording', () => {
  assert.equal(questionMatchesIntent('How much does it cost to send a parcel?', GAS_CUES), false);
  assert.equal(questionMatchesIntent('What is the cost of medical research?', GAS_CUES), false);
  for (const text of ['What is ETH worth today?', 'What is the Bitcoin price?', 'What is TON worth?', 'What is XMR trading at?', 'What is PEPE worth?', 'What is my house worth?', 'What is this painting worth?', 'What is gold trading at?', 'What is the price of milk?', 'What is the Eiffel Tower worth?']) {
    assert.equal(stockTextMatchesIntent(text), false, text);
  }
  for (const text of ['House price today', 'How is Gold trading?', 'Painting price today']) {
    assert.equal(stockTextMatchesIntent(text), false, text);
  }
  assert.equal(questionMatchesIntent('Research the cheapest flight to Miami', ACADEMIC_CUES), false);
  assert.equal(questionMatchesIntent('What does market research cost?', ACADEMIC_CUES), false);
  for (const text of ['Find a news article', 'Show shopping articles', 'Police published their findings', 'Read my personal journal', 'research']) {
    assert.equal(freeTextMatchesIntent(text, ACADEMIC_CUES), false, text);
  }
  for (const text of ['airline fees', 'university fees', 'lawyer fees', 'bank transfer cost', 'gas stove prices']) {
    assert.equal(freeTextMatchesIntent(text, GAS_CUES), false, text);
  }
});
