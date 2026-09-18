import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import paymentMethodVerifyRouter from './checkPaymentMethodVerify.js';

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/payment-method-verify', paymentMethodVerifyRouter);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const stubbed = await handler(String(url), init, original);
    if (stubbed !== undefined) return stubbed;
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
}

test('payment-method-verify: missing input answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/payment-method-verify`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('payment-method-verify: a Visa BIN is identified from the static prefix table', async (t) => {
  stubFetch(t, (url) => {
    if (url.startsWith('https://lookup.binlist.net')) {
      return new Response(JSON.stringify({ scheme: 'visa', type: 'debit', bank: { name: 'Example Bank' }, country: { name: 'United States' } }), { status: 200 });
    }
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/payment-method-verify?card_number=411111`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.network, 'Visa');
  assert.equal(body.can_verify_live_status, false);
  assert.match(body.summary, /Visa/);
});

test('payment-method-verify: binlist outage still answers from the static table alone', async (t) => {
  stubFetch(t, (url) => {
    if (url.startsWith('https://lookup.binlist.net')) return new Response('', { status: 500 });
    return undefined;
  });
  const base = startServer(t);
  const res = await fetch(`${base}/payment-method-verify?card_number=511111`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.network, 'Mastercard');
  assert.equal(body.issuing_bank, null);
});

test('payment-method-verify: alias params and a bare network name are accepted', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/payment-method-verify?payment_method=American Express`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.network, 'American Express');
});

test('payment-method-verify: a payment app name is confirmed by name only', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/payment-method-verify?payment_method=venmo`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.payment_app, 'venmo');
  assert.equal(body.can_verify_live_status, false);
});

test('payment-method-verify: nonsense input is refused honestly, not crashed', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/payment-method-verify?payment_method=${encodeURIComponent('zzz qqqq nonsense')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
});

test('payment-method-verify: a 12,000+ char input is handled without crashing', async (t) => {
  stubFetch(t, (url) => {
    if (url.startsWith('https://lookup.binlist.net')) return new Response('', { status: 500 });
    return undefined;
  });
  const base = startServer(t);
  const huge = `card is 411111 ${'a'.repeat(12_500)}`;
  const res = await fetch(`${base}/payment-method-verify?card_number=${encodeURIComponent(huge)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.network, 'Visa');
});
