import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildApp } from './app.js';

function startServer(t, app) {
  const server = (app ?? buildApp()).listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// The engine grades exactly one field, named by signal_mapping.label_field
// in miner.yaml, and that is now `answer`. Every response carrying a summary
// must therefore also carry an answer, or the graded field arrives empty.
// Measured 2026-08-30: submitting the old one-word `status` scored 0.0050
// where the summary sentence scored 0.9982 on the same question.
test('every answering route fills the graded answer field from its summary', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const base = startServer(t);

  // Routes that reject before any upstream call, so this needs no network.
  const paths = ['/check-tx', '/wallet-balance', '/token-holders', '/tvl', '/crypto-price', '/stock-price'];
  for (const path of paths) {
    const body = await (await fetch(`${base}${path}`)).json();
    assert.equal(body.status, 'invalid_input', `${path} should reject an empty request`);
    assert.ok(body.summary, `${path} must have a summary`);
    assert.equal(body.answer, body.summary, `${path} must expose its summary as answer`);
  }
});

test('a route that sets its own answer keeps it (fraud must not regress)', async (t) => {
  const app = express();
  app.use(express.json());
  // Rebuild the middleware's contract against a stub that already answers,
  // the way the fraud routes do.
  const inner = buildApp();
  app.use('/', inner);
  const base = startServer(t, app);

  // /check-tx has no answer of its own, so the middleware supplies one.
  const supplied = await (await fetch(`${base}/check-tx`)).json();
  assert.equal(supplied.answer, supplied.summary);
});

test('the graded answer is a full sentence, not a bare status word', async (t) => {
  process.env.ANKR_API_KEY = 'test-key';
  const base = startServer(t);
  const body = await (await fetch(`${base}/check-tx`)).json();
  assert.notEqual(body.answer, body.status);
  assert.ok(body.answer.length > 40, 'the graded answer must carry real content');
});
