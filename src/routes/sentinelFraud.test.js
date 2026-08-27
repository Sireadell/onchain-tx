import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';

async function withServer(run) {
  const server = buildApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('fraud-query forwards the request and adds TxLens-compatible fields', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url.toString(), 'https://telegraph-sentinel-40vp.onrender.com/fraud-query');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { query: 'Was BitConnect a Ponzi scheme?' });
    return new Response(JSON.stringify({
      mode: 'fraud_knowledge',
      label: 'ANSWERED',
      reason: 'Yes.',
      confidence: 0.99,
      assessment_status: 'ASSESSED',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/fraud-query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'Was BitConnect a Ponzi scheme?' }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.label, 'ANSWERED');
      assert.equal(body.status, 'ANSWERED');
      assert.equal(body.summary, 'Yes.');
      assert.equal(body.reason, 'Yes.');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('assess-wallet preserves Sentinel validation errors', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ error: 'wallet is required' }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );

  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'wallet is required' });
    });
  } finally {
    global.fetch = originalFetch;
  }
});
