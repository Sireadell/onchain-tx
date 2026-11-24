import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base58ByteLength,
  isSolanaAddress,
  isSolanaSignature,
  extractSolanaAddresses,
  extractSolanaSignature,
  wantsSolana,
  knownSolanaTokenFromText,
  formatTokenAmount,
} from './solanaRpc.js';

const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

test('solana: addresses decode to 32 bytes, signatures to 64', () => {
  assert.equal(base58ByteLength(WALLET), 32);
  assert.equal(base58ByteLength(USDC), 32);
  assert.equal(base58ByteLength(WSOL), 32);
  assert.equal(base58ByteLength(SIG), 64);
  assert.equal(base58ByteLength('0OIl'), null);
  assert.ok(isSolanaAddress(WALLET));
  assert.ok(isSolanaSignature(SIG));
  assert.equal(isSolanaAddress(SIG), false);
  assert.equal(isSolanaAddress('abcdefghijkmnopqrstuvwxyzabcdefghijkmn'), false);
});

test('solana: extraction from sentences, in written order, no EVM matches', () => {
  assert.deepEqual(extractSolanaAddresses(`What is the balance of ${WALLET}?`), [WALLET]);
  assert.deepEqual(extractSolanaAddresses(`${WALLET} holds ${USDC}`), [WALLET, USDC]);
  assert.deepEqual(extractSolanaAddresses('0x' + 'a'.repeat(40)), []);
  assert.deepEqual(extractSolanaAddresses('Internationalization considerations regarding wallets'), []);
  assert.equal(extractSolanaSignature(`Did ${SIG} confirm?`), SIG);
  assert.equal(extractSolanaSignature(WALLET), null);
});

test('solana: wantsSolana picks Solana by chain word, entity or word, never over a 0x entity', () => {
  assert.equal(wantsSolana('solana', ''), true);
  assert.equal(wantsSolana('sol', undefined), true);
  assert.equal(wantsSolana(undefined, 'How much SOL does it hold'), true);
  assert.equal(wantsSolana(undefined, `balance of ${WALLET}`), true);
  assert.equal(wantsSolana(undefined, `status of ${SIG}`), true);
  assert.equal(wantsSolana('solana', '0x' + 'a'.repeat(40)), false);
  assert.equal(wantsSolana('eth', 'USDC balance of 0x' + 'b'.repeat(40) + ' on Ethereum'), false);
  assert.equal(wantsSolana('eth', 'holders of Chainlink on Ethereum'), false);
  assert.equal(wantsSolana(undefined, undefined), false);
});

test('solana: known tokens read from symbols', () => {
  assert.equal(knownSolanaTokenFromText('how much USDC does it hold')?.mint, USDC);
  assert.equal(knownSolanaTokenFromText('wSOL balance')?.mint, WSOL);
  assert.equal(knownSolanaTokenFromText('Tether supply')?.symbol, 'USDT');
  assert.equal(knownSolanaTokenFromText('nothing here'), null);
});

test('solana: formatTokenAmount is exact', () => {
  assert.equal(formatTokenAmount(9300003431692335n, 9), '9300003.431692335');
  assert.equal(formatTokenAmount('1500000000', 9), '1.5');
  assert.equal(formatTokenAmount(5, 9), '0.000000005');
  assert.equal(formatTokenAmount(42, 0), '42');
});
