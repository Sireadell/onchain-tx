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
    if (url.startsWith('https://lookup.binlist.net') || url.startsWith('https://data.handyapi.com')) return new Response('', { status: 500 });
    return undefined;
  });
  const base = startServer(t);
  const huge = `card is 411111 ${'a'.repeat(12_500)}`;
  const res = await fetch(`${base}/payment-method-verify?card_number=${encodeURIComponent(huge)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.network, 'Visa');
});

function stubDirectories(t, { handy, routing } = {}) {
  stubFetch(t, (url) => {
    if (url.startsWith('https://data.handyapi.com/bin/')) {
      return handy ? new Response(JSON.stringify(handy), { status: 200 }) : new Response('', { status: 500 });
    }
    if (url.startsWith('https://lookup.binlist.net')) return new Response('', { status: 500 });
    if (url.startsWith('https://bankrouting.io/')) {
      return routing ? new Response(JSON.stringify({ status: 'success', data: routing }), { status: 200 }) : new Response('', { status: 400 });
    }
    return undefined;
  });
}

const ask = async (base, q) => (await fetch(`${base}/payment-method-verify?query=${encodeURIComponent(q)}`)).json();

test('payment-method-verify: last four digits and an issuer get an honest answer, not a refusal', async (t) => {
  stubDirectories(t);
  const base = startServer(t);
  const body = await ask(base, 'Can you verify if the payment method ending in 4567, issued by Chase bank, is active and valid for transactions in USD?');
  assert.equal(body.status, 'ok');
  assert.equal(body.verdict, 'unverifiable');
  assert.equal(body.last4, '4567');
  assert.match(body.summary, /^Cannot be verified/);
  assert.match(body.summary, /first 6 to 8 card digits/);
});

test('payment-method-verify: wrong network, wrong issuer and a bad routing number are each called out', async (t) => {
  stubDirectories(t, { handy: { Status: 'SUCCESS', Scheme: 'VISA', Type: 'CREDIT', Issuer: 'INTL HDQTRS-CENTER OWNED', Country: { Name: 'United States' } } });
  const base = startServer(t);
  const body = await ask(base, 'Can you verify if the credit card number starting with 400000 is a valid Mastercard issued by Bank of America, and if the routing number 123456789 is active for ACH transfers?');
  assert.equal(body.verdict, 'invalid');
  assert.equal(body.valid, false);
  assert.equal(body.network, 'Visa');
  assert.equal(body.routing_valid, false);
  assert.match(body.summary, /^No, it does not check out/);
  assert.match(body.summary, /not Mastercard/);
  assert.match(body.summary, /not Bank of America/);
  assert.match(body.summary, /123456789 fails the ABA check digit/);
});

test('payment-method-verify: a real routing number is named with its bank', async (t) => {
  stubDirectories(t, {
    handy: { Status: 'SUCCESS', Scheme: 'VISA', Type: 'DEBIT', Issuer: 'JPMORGAN CHASE BANK N.A.', Country: { Name: 'United States' } },
    routing: { bank_name: 'BANK OF AMERICA, N.A., CA', city: 'SAN FRANCISCO', state: 'CA' },
  });
  const base = startServer(t);
  const body = await ask(base, 'Can you verify if the Visa card with BIN 453210 is active and issued by Chase Bank, and confirm if the routing number 121000358 is a valid ACH number?');
  assert.equal(body.verdict, 'valid_format');
  assert.equal(body.routing_valid, true);
  assert.equal(body.routing_bank, 'BANK OF AMERICA, N.A., CA');
  assert.match(body.summary, /matches the issuer named in the question \(Chase\)/);
});

test('payment-method-verify: a placeholder Stripe token is explained', async (t) => {
  stubDirectories(t);
  const base = startServer(t);
  const body = await ask(base, "Can you verify if the payment token 'tok_123abc456def' is active and issued by Chase Bank?");
  assert.equal(body.verdict, 'unverifiable');
  assert.match(body.summary, /Stripe's token format/);
  assert.match(body.summary, /placeholder/);
});

test('payment-method-verify: Luhn and ABA helpers', async () => {
  const { luhnValid, abaValid } = await import('./checkPaymentMethodVerify.js');
  assert.equal(luhnValid('4111111111111111'), true);
  assert.equal(luhnValid('4111111111111112'), false);
  assert.equal(abaValid('121000358'), true);
  assert.equal(abaValid('021000021'), true);
  assert.equal(abaValid('123456789'), false);
});
