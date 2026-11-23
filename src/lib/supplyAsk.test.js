import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAsk, tokenCandidates, namedBurnAddresses, pct, fmt } from './supplyAsk.js';

test('parseAsk reads burn share, circulating, holders', () => {
  assert.equal(parseAsk('what share of the USD Coin supply on Base is held by burn addresses?').burn, true);
  assert.equal(parseAsk('circulating supply after excluding burned tokens').circulating, true);
  assert.equal(parseAsk('how many holders does DAI have').holders, true);
  assert.equal(parseAsk('What is the total supply of UNI on ethereum?').burn, false);
});

test('tokenCandidates finds names, tickers in brackets and mixed-case tickers', () => {
  assert.ok(tokenCandidates('What is the total supply of ether.fi Staked ETH (eETH) on Ethereum?').includes('eETH'));
  assert.ok(tokenCandidates('its on-chain total supply on Base at block 25,000,000 for cbBTC?').includes('cbBTC'));
  assert.ok(tokenCandidates('the USD Coin supply on Base').includes('USD Coin'));
});

test('short burn address forms are recognised, and percentages stay exact', () => {
  assert.equal(namedBurnAddresses('held at 0xdead').length, 1);
  assert.equal(pct(1n, 4n), '25.000000');
  assert.equal(fmt(1234500000n, 6), '1,234.5');
});
