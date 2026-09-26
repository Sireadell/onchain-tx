import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { firstUsableValue, freeTextParam, isPlaceholder } from '../lib/entityExtract.js';
import { parseCoordinates } from '../lib/questionParse.js';
import { decodeTokenTransfer, knownTokenByAddress } from '../lib/knownTokens.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('placeholders the request builder writes for a missing value are treated as missing', () => {
  for (const v of ['<nil>', 'nil', 'null', 'undefined', ' <NIL> ', 'n/a']) assert.equal(isPlaceholder(v), true, v);
  for (const v of ['nile', 'USDC', '0', '']) assert.equal(isPlaceholder(v), false, v);
  assert.equal(firstUsableValue('<nil>', 'eth'), 'eth');
  assert.equal(freeTextParam({ question: '<nil>', query: 'real question' }), 'real question');
});

test('wallet-balance: token=<nil> answers the native balance instead of refusing', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return original(url, init);
    if (String(url).includes('rpc.ankr.com')) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' }), { status: 200 });
    return new Response('{}', { status: 500 });
  };
  t.after(() => { globalThis.fetch = original; });
  const base = startServer(t);
  const body = await (await fetch(`${base}/wallet-balance?address=0x742d35Cc6634C0532925a3b844Bc454e4438f444&chain=eth&token=%3Cnil%3E`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /holds 1 ETH/);
});

test('coordinates written with hemisphere letters are read', () => {
  assert.deepEqual(parseCoordinates('34.0522 N, 118.2437 W'), { latitude: 34.0522, longitude: -118.2437 });
  assert.deepEqual(parseCoordinates('34.0522° N, 118.2437° W'), { latitude: 34.0522, longitude: -118.2437 });
  assert.deepEqual(parseCoordinates('33.87° S 151.21° E'), { latitude: -33.87, longitude: 151.21 });
  assert.equal(parseCoordinates('Is it 5 N or 3 E'), null);
});

test('a USDC transfer() call is decoded to its recipient and amount', () => {
  const input = '0xa9059cbb00000000000000000000000081bf3363fc314b88c9046e6ad318360c8e10b4c50000000000000000000000000000000000000000000000000000000005f5e100';
  const t = decodeTokenTransfer(input);
  assert.equal(t.to, '0x81bf3363fc314b88c9046e6ad318360c8e10b4c5');
  assert.equal(t.amount, 100000000n);
  assert.deepEqual(knownTokenByAddress('eth', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'), { symbol: 'USDC', decimals: 6 });
  assert.equal(decodeTokenTransfer('0x'), null);
});
