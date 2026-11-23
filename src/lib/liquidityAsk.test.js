import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLiquidityAsk } from './liquidityAsk.js';

test('named pools give symbols, chain and venue', () => {
  const a = parseLiquidityAsk('Verify total liquidity depth for Balancer rETH/WETH pool on Ethereum.');
  assert.deepEqual([a.a, a.b, a.chain, a.dex], ['rETH', 'WETH', 'ethereum', 'balancer']);
  const b = parseLiquidityAsk('Verify total liquidity depth for Aerodrome DEGEN/WETH pool on Base.');
  assert.deepEqual([b.a, b.b, b.chain, b.dex], ['DEGEN', 'WETH', 'base', 'aerodrome']);
});

test('pool ids and swap questions are read', () => {
  const id = parseLiquidityAsk('ETH-WETH-USDC-005');
  assert.deepEqual([id.a, id.b, id.chain, id.fee], ['WETH', 'USDC', 'ethereum', '005']);
  const sw = parseLiquidityAsk('If I push 0.873 AAVE through the AAVE/WETH Uniswap V2 pair, how much WETH do I get?');
  assert.deepEqual(sw.swap, { amount: 0.873, symbol: 'AAVE' });
  assert.equal(sw.version, '2');
});
