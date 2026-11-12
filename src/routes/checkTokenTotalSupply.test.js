import { test } from 'node:test';
import assert from 'node:assert/strict';

test('token supply: native ETH is answered from the supply tracker, not refused', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.coingecko.com/api/v3/coins/ethereum')) {
      return new Response(JSON.stringify({ last_updated: '2026-11-12T09:40:49.000Z', market_data: { total_supply: 122212724.47, circulating_supply: 122212724.47, max_supply: null } }), { status: 200 });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  const express = (await import('express')).default;
  const router = (await import('./checkTokenTotalSupply.js')).default;
  const app = express();
  app.use('/s', router);
  const server = app.listen(0);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/s?chain=ethereum&token=ETH&block=1.8e%2B07`);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(body.summary, /122,212,724 ETH/);
  assert.match(body.summary, /block 18000000/);
  assert.equal(body.requested_block, '18000000');
});
