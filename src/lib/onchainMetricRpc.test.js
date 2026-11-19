import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  genericCalls, genericSelector, encodeGeneric, decodeGeneric, blockRangeFromText,
  tokenBalanceAsk, knownContractIn, decodeTransferLog, TRANSFER_TOPIC,
} from './onchainMetricRpc.js';

test('a named call becomes a call, prose in brackets does not', () => {
  const calls = genericCalls('call delay() on 0x6d903f6003cca6255D85CcA4D3B5E5146dC33925 (Ethereum) and USDC (0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359)');
  assert.deepEqual(calls, [{ name: 'delay', args: [] }]);
  assert.deepEqual(genericCalls('owner() then delay()', new Set(['owner'])).map((c) => c.name), ['delay']);
});

test('selectors are keccak256 of the signature', () => {
  assert.equal(genericSelector({ name: 'delay', args: [] }), '0x6a42b8f8');
  assert.equal(genericSelector({ name: 'Transfer', args: [] }).length, 10);
  const [call] = genericCalls('getRoleAdmin(0x0000000000000000000000000000000000000000000000000000000000000000)');
  assert.equal(encodeGeneric(call), `${genericSelector(call)}${'0'.repeat(64)}`);
  assert.equal(call.args[0].type, 'bytes32');
});

test('return words are read as the likely type', () => {
  assert.equal(decodeGeneric(`0x${(172800).toString(16).padStart(64, '0')}`, { wantsSeconds: true }).value, '172800 seconds (2 days)');
  assert.equal(decodeGeneric(`0x${'0'.repeat(24)}${'ab'.repeat(20)}`).value, `0x${'ab'.repeat(20)}`);
  const str = `0x${'20'.padStart(64, '0')}${'3'.padStart(64, '0')}${Buffer.from('abc').toString('hex').padEnd(64, '0')}`;
  assert.equal(decodeGeneric(str).value, '"abc"');
  assert.equal(decodeGeneric('0x'), null);
});

test('block ranges, token symbols and known collections are found in text', () => {
  assert.deepEqual(blockRangeFromText('between blocks 55,000,000 and 55,000,002'), { from: '55000000', to: '55000002' });
  assert.deepEqual(blockRangeFromText('from block 200 to block 100'), null);
  assert.deepEqual(blockRangeFromText('from block 2000 to block 1000'), { from: '1000', to: '2000' });
  assert.equal(tokenBalanceAsk('What was the cbBTC balance held by 0x..', 'base').token, '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf');
  assert.equal(tokenBalanceAsk('What was the cbBTC balance held by 0x..', 'polygon'), null);
  assert.equal(knownContractIn('BAYC id 100', 'eth'), '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D');
  assert.equal(knownContractIn('BAYC id 100', 'base'), null);
});

test('a Transfer log decodes sender, receiver and value', () => {
  const d = decodeTransferLog({
    address: '0xt', topics: [TRANSFER_TOPIC, `0x${'0'.repeat(24)}${'11'.repeat(20)}`, `0x${'0'.repeat(24)}${'22'.repeat(20)}`],
    data: `0x${'64'.padStart(64, '0')}`, blockNumber: '0x10', logIndex: '0x3', transactionHash: '0xh',
  });
  assert.equal(d.from, `0x${'11'.repeat(20)}`);
  assert.equal(d.to, `0x${'22'.repeat(20)}`);
  assert.equal(d.value, 100n);
  assert.equal(d.log_index, 3);
  assert.equal(d.block, '16');
  assert.equal(decodeTransferLog({ topics: ['0xother'] }), null);
});
