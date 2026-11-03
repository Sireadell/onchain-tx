import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockFromText, slotFromText, explicitCalls, phraseCalls, completeArgs, encodeCall,
  signatureText, decodeResult, addressesIn,
} from './onchainMetric.js';

const CONTRACT = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';

test('block is read from several phrasings and ignores hex values', () => {
  assert.equal(blockFromText('at block 19,600,000 please'), '19600000');
  assert.equal(blockFromText('historical block 19,300,000'), '19300000');
  assert.equal(blockFromText('block number 61,000,000'), '61000000');
  assert.equal(blockFromText('latest value of owner()'), null);
});

test('storage slot is read in hex or decimal', () => {
  assert.equal(slotFromText('stored at position 0x8 in the pair'), '0x8');
  assert.equal(slotFromText('storage slot 12'), '0xc');
  assert.equal(slotFromText('no slot here'), null);
});

test('explicit calls are found with their arguments, scientific notation included', () => {
  const calls = explicitCalls('what did totalAssets() return, and convertToShares(1e18) give?');
  assert.deepEqual(calls.map((c) => c.name), ['totalAssets', 'convertToShares']);
  assert.equal(calls[1].args[0].value, 10n ** 18n);
  assert.equal(encodeCall(calls[1]), `0xc6e6f592${(10n ** 18n).toString(16).padStart(64, '0')}`);
});

test('unknown function names are ignored', () => {
  assert.deepEqual(explicitCalls('call frobnicate(3) now'), []);
});

test('plain words map to a view, and owner-of beats owner', () => {
  assert.deepEqual(phraseCalls('what is the total supply?').map((c) => c.name), ['totalSupply']);
  assert.deepEqual(phraseCalls('Which wallet held BAYC id 100?').map((c) => c.name), ['ownerOf']);
  assert.deepEqual(phraseCalls('who is the owner of token 5').map((c) => c.name), ['ownerOf']);
});

test('missing arguments are filled from the question', () => {
  const text = `Which wallet held BAYC id 100 (contract ${CONTRACT})?`;
  const call = completeArgs({ name: 'ownerOf', args: [] }, text, CONTRACT);
  assert.equal(call.args[0].value, 100n);
  const bal = completeArgs({ name: 'balanceOf', args: [] }, `balance of ${'0x' + 'ab'.repeat(20)} in ${CONTRACT}`, CONTRACT);
  assert.equal(bal.args[0].value, '0x' + 'ab'.repeat(20));
  assert.equal(completeArgs({ name: 'ownerOf', args: [] }, 'no id here', CONTRACT), null);
});

test('results decode: address, signed answer scaled by decimals, slot0 with negative tick', () => {
  assert.equal(decodeResult('owner', `0x${'0'.repeat(24)}${'ab'.repeat(20)}`).value, '0x' + 'ab'.repeat(20));
  const word = (n) => BigInt.asUintN(256, n).toString(16).padStart(64, '0');
  const round = `0x${word(5n)}${word(99989463n)}${word(1n)}${word(1728137831n)}${word(5n)}`;
  assert.equal(decodeResult('latestRoundData', round, { feedDecimals: 8 }).value, '0.99989463; raw answer 99989463, round 5, timestamp 1728137831');
  const slot0 = `0x${word(79231557136937071450841n)}${word(-276324n)}`;
  assert.equal(decodeResult('slot0', slot0).value, 'sqrtPriceX96 79231557136937071450841 and tick -276324');
  assert.equal(decodeResult('owner', '0x'), null);
});

test('signature text and address list', () => {
  assert.equal(signatureText({ name: 'ownerOf', args: [{ type: 'uint', value: 100n }] }), 'ownerOf(100)');
  assert.deepEqual(addressesIn(`a ${CONTRACT} b ${CONTRACT}`), [CONTRACT]);
});
