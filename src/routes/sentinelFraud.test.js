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

test('assess-wallet answers Sentinel validation errors instead of failing', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ error: 'wallet is required' }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );

  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'invalid_input');
      assert.equal(body.error, undefined);
      assert.match(body.summary, /wallet is required/);
      assert.match(body.summary, /wallet parameter/);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('assess-wallet POST extracts a bare address out of a plain-language question when wallet is missing', async () => {
  const originalFetch = global.fetch;
  const address = `0x${'b'.repeat(40)}`;
  global.fetch = async (url, options) => {
    assert.equal(url.toString(), 'https://telegraph-sentinel-40vp.onrender.com/assess-wallet');
    const body = JSON.parse(options.body);
    assert.equal(body.wallet, address);
    return new Response(JSON.stringify({
      label: 'HIGH', reason: 'sanctions match', confidence: 0.95, assessment_status: 'ASSESSED',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: `Is Ethereum wallet ${address} linked to fraud or sanctions? Give me the evidence.` }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.label, 'HIGH');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('assess-wallet GET extracts a bare address out of a plain-language query param when wallet is missing', async () => {
  const originalFetch = global.fetch;
  const address = `0x${'c'.repeat(40)}`;
  global.fetch = async (url) => {
    assert.equal(url.searchParams.get('wallet'), address);
    return new Response(JSON.stringify({
      label: 'LOW', reason: 'known exchange wallet', confidence: 0.9, assessment_status: 'ASSESSED',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await withServer(async (base) => {
      const question = encodeURIComponent(`Before I send anything to ${address}, is there anything I should know about it?`);
      const response = await originalFetch(`${base}/assess-wallet?question=${question}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.label, 'LOW');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('assess-wallet still rejects cleanly when no address is present anywhere in the request', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ error: 'wallet is required' }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );

  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'Should I be worried about this wallet? What is the risk level?' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'invalid_input');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sentinel outage returns an honest inconclusive answer instead of a failed request', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ error: 'service unavailable' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );

  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet?wallet=0x${'a'.repeat(40)}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'inconclusive');
      assert.equal(body.assessment_status, 'INCONCLUSIVE');
      assert.equal(body.confidence, 0);
      assert.match(body.summary, /temporarily unavailable/);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sentinel non-JSON outage page returns an honest inconclusive answer', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('<html>rate limited</html>', {
    status: 429,
    headers: { 'content-type': 'text/html' },
  });

  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet?wallet=0x${'a'.repeat(40)}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'inconclusive');
      assert.equal(body.assessment_status, 'INCONCLUSIVE');
      assert.equal(body.confidence, 0);
      assert.match(body.summary, /temporarily unavailable/);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sentinel successful non-JSON response remains an invalid upstream error', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('<html>not JSON</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet?wallet=0x${'a'.repeat(40)}`);
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error, 'Sentinel returned an invalid response');
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sentinel non-JSON validation response becomes invalid_input', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('bad wallet', { status: 422 });
  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'invalid_input');
    });
  } finally { global.fetch = originalFetch; }
});

test('Sentinel empty 204 becomes inconclusive with zero confidence', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(null, { status: 204 });
  try {
    await withServer(async (base) => {
      const response = await originalFetch(`${base}/assess-wallet?wallet=0x${'a'.repeat(40)}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'inconclusive');
      assert.equal(body.confidence, 0);
    });
  } finally { global.fetch = originalFetch; }
});
