import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFee, confirmationsAt, formatDuration, decodeLogs, isUnlimited, withCommas, internalTransfers,
  TRANSFER_TOPIC, APPROVAL_TOPIC,
} from './transferVerify.js';

const pad = (hex) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;

test('fee split matches a real Ethereum transaction (block 15,300,000)', () => {
  const fee = computeFee({
    tx: { gas: '0x7a120' },
    receipt: { gasUsed: `0x${(333711).toString(16)}`, effectiveGasPrice: `0x${(20854280318n).toString(16)}` },
    block: { baseFeePerGas: `0x${(18854280317n).toString(16)}` },
  });
  assert.equal(fee.total_fee_wei, '6959302739200098');
  assert.equal(fee.burned_wei, '6291880738866387');
  assert.equal(fee.tip_wei, '667422000333711');
  assert.equal(fee.total_fee, '0.006959302739200098');
  assert.equal(fee.effective_gas_price_gwei, '20.854280318');
});

test('layer-1 data fee and blob fee are added to the total', () => {
  const fee = computeFee({
    tx: {},
    receipt: { gasUsed: '0x5208', effectiveGasPrice: '0x1', l1Fee: '0x64', blobGasUsed: '0x20000', blobGasPrice: '0x2' },
    block: { baseFeePerGas: '0x1' },
  });
  assert.equal(fee.l1_fee_wei, '100');
  assert.equal(fee.blob_fee_wei, String(131072 * 2));
  assert.equal(fee.total_fee_wei, String(21000 + 100 + 131072 * 2));
});

test('fee with no block header still reports the total and leaves the burn unknown', () => {
  const fee = computeFee({ tx: {}, receipt: { gasUsed: '0x5208', effectiveGasPrice: '0xa' }, block: null });
  assert.equal(fee.total_fee_wei, '210000');
  assert.equal(fee.burned_wei, null);
});

test('confirmations count the inclusion block as the first one', () => {
  assert.equal(confirmationsAt(6_200_000, 24_000_000), 17_800_001n);
  assert.equal(confirmationsAt(100, 100), 1n);
  assert.equal(confirmationsAt(200, 100), 0n);
});

test('durations read in days, hours and minutes', () => {
  assert.equal(formatDuration(35_600_000), '412 days 0 hours 53 minutes');
  assert.equal(formatDuration(75), '1 minute 15 seconds');
});

test('decodeLogs reads ERC-20, NFT and approval events', () => {
  const addr = (a) => pad(a);
  const logs = [
    { address: '0xTOKEN', topics: [TRANSFER_TOPIC, addr('0x1'), addr('0x2')], data: pad('0x64') },
    { address: '0xNFT', topics: [TRANSFER_TOPIC, addr('0x1'), addr('0x2'), pad('0x2a')], data: '0x' },
    { address: '0xTOKEN', topics: [APPROVAL_TOPIC, addr('0x3'), addr('0x4')], data: `0x${'f'.repeat(64)}` },
  ];
  const out = decodeLogs(logs);
  assert.equal(out[0].kind, 'erc20_transfer');
  assert.equal(out[0].amount, 100n);
  assert.equal(out[1].kind, 'nft_transfer');
  assert.equal(out[1].token_id, 42n);
  assert.equal(out[2].kind, 'approval');
  assert.equal(isUnlimited(out[2].amount), true);
});

test('withCommas groups digits', () => {
  assert.equal(withCommas(6959302739200098n), '6,959,302,739,200,098');
});

test('internalTransfers keeps value moves inside the call tree and skips failed branches', () => {
  const trace = {
    type: 'CALL', from: '0xa', to: '0xb', value: '0x10',
    calls: [
      { type: 'CALL', from: '0xb', to: '0xc', value: '0x5' },
      { type: 'DELEGATECALL', from: '0xb', to: '0xd', value: '0x9' },
      { type: 'CALL', from: '0xb', to: '0xe', value: '0x7', error: 'execution reverted', calls: [{ type: 'CALL', from: '0xe', to: '0xf', value: '0x7' }] },
      { type: 'CALL', from: '0xb', to: '0xg', value: '0x0' },
    ],
  };
  const out = internalTransfers(trace);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { from: '0xb', to: '0xc', value: 5n });
  assert.deepEqual(internalTransfers(null), []);
});
