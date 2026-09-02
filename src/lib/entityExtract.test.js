import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTxHash,
  extractAddress,
  extractHostname,
  tokenize,
  freeTextParam,
  extractSubject,
  extractTicker,
  looksLikeSentence,
} from './entityExtract.js';

const HASH = '0x' + '1'.repeat(64);
const ADDR = '0x' + 'a'.repeat(40);

test('extractTxHash finds a bare hash', () => {
  assert.equal(extractTxHash(HASH), HASH);
});

test('extractTxHash finds a hash wrapped in a question', () => {
  assert.equal(extractTxHash(`Is ${HASH} confirmed?`), HASH);
});

test('extractTxHash does not fire on a 40-hex address', () => {
  assert.equal(extractTxHash(ADDR), null);
});

test('extractTxHash returns null for garbage', () => {
  assert.equal(extractTxHash('vitalik.eth'), null);
  assert.equal(extractTxHash(undefined), null);
});

test('extractAddress finds a bare address', () => {
  assert.equal(extractAddress(ADDR), ADDR);
});

test('extractAddress finds an address wrapped in a question', () => {
  assert.equal(extractAddress(`How much ETH does ${ADDR} hold?`), ADDR);
});

test('extractAddress does not fire on the first 40 chars of a longer hash', () => {
  assert.equal(extractAddress(HASH), null);
});

test('extractHostname strips protocol and path from a full URL', () => {
  assert.equal(extractHostname('https://example.com/path'), 'example.com');
});

test('extractHostname strips a port from host:port', () => {
  assert.equal(extractHostname('github.com:443'), 'github.com');
});

test('extractHostname finds a hostname inside a sentence', () => {
  assert.equal(extractHostname('Is the SSL certificate for github.com valid?'), 'github.com');
});

test('extractHostname returns null when nothing domain-shaped is present', () => {
  assert.equal(extractHostname('is this thing secure'), null);
});

test('tokenize lowercases and splits on non-alphanumerics', () => {
  assert.deepEqual(tokenize('What is Bitcoin worth?'), ['what', 'is', 'bitcoin', 'worth']);
});

test('tokenize returns empty array for non-string input', () => {
  assert.deepEqual(tokenize(undefined), []);
});

// Free-text fallback, added 2026-08-30. The deployed miner was answering
// invalid_input to whole questions on eight of thirteen routes, including
// its flagship ONCHAIN_TX_LOOKUP endpoint, because those routes only ever
// read their structured parameter.
test('freeTextParam reads whichever free-text field the caller used', () => {
  assert.equal(freeTextParam({ question: 'is it confirmed' }), 'is it confirmed');
  assert.equal(freeTextParam({ q: 'is it confirmed' }), 'is it confirmed');
  assert.equal(freeTextParam({ query: 'is it confirmed' }), 'is it confirmed');
  assert.equal(freeTextParam({ text: 'is it confirmed' }), 'is it confirmed');
  assert.equal(freeTextParam({ input: 'is it confirmed' }), 'is it confirmed');
  // question wins when more than one is present, and blank never counts.
  assert.equal(freeTextParam({ q: 'second', question: 'first' }), 'first');
  assert.equal(freeTextParam({ question: '   ' }), null);
  assert.equal(freeTextParam({ tx_hash: '0xabc' }), null);
  assert.equal(freeTextParam(null), null);
});

test('extractSubject reduces a question to the thing being asked about', () => {
  assert.equal(extractSubject('What is the price of Apple stock right now?'), 'Apple');
  assert.equal(extractSubject('How much is Bitcoin worth?'), 'Bitcoin');
  assert.equal(extractSubject('What is the TVL of Uniswap?'), 'Uniswap');
  assert.equal(extractSubject('what is the total value locked in Aave'), 'Aave');
  assert.equal(extractSubject('How much TVL does Curve have on Ethereum?'), 'Curve on Ethereum');
  // A bare name is already the subject and must survive untouched.
  assert.equal(extractSubject('uniswap'), 'uniswap');
  assert.equal(extractSubject('MSFT'), 'MSFT');
  assert.equal(extractSubject(null), null);
});

test('extractTicker prefers an explicit symbol over the prose name', () => {
  assert.equal(extractTicker('What is AAPL trading at?'), 'AAPL');
  assert.equal(extractTicker('What is Tesla stock price today?'), 'Tesla');
  assert.equal(extractTicker(null), null);
});

test('extractSubject strips a "locked in" clause the lead pattern leaves behind', () => {
  // The lead strip stops at the first "is", so these arrive here as
  // "locked in Uniswap" and used to be looked up under that name.
  assert.equal(extractSubject('How much value is locked in Uniswap?'), 'Uniswap');
  assert.equal(extractSubject('How much money is locked in Curve right now?'), 'Curve');
  assert.equal(extractSubject('How much value is staked in Lido?'), 'Lido');
});

test('extractSubject leaves the cases that already worked alone', () => {
  assert.equal(extractSubject('What is the TVL of Aave?'), 'Aave');
  assert.equal(extractSubject('What is the total value locked in Lido?'), 'Lido');
  assert.equal(extractSubject('uniswap'), 'uniswap');
});

test('looksLikeSentence tells prose from a bare value', () => {
  assert.equal(looksLikeSentence('How much value is locked in Uniswap?'), true);
  assert.equal(looksLikeSentence('How much is Apple stock right now'), true);
  assert.equal(looksLikeSentence('uniswap'), false);
  assert.equal(looksLikeSentence('AAPL'), false);
  assert.equal(looksLikeSentence('aave-v3'), false);
  // A chain name can legitimately run to three words; it must not be mistaken
  // for a question and torn apart.
  assert.equal(looksLikeSentence('Binance Smart Chain'), false);
});

test('looksLikeSentence is safe on non-strings and blanks', () => {
  assert.equal(looksLikeSentence(undefined), false);
  assert.equal(looksLikeSentence(null), false);
  assert.equal(looksLikeSentence(42), false);
  assert.equal(looksLikeSentence('   '), false);
});
