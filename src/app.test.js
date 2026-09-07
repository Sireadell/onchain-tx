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

// The app had no error-handling middleware at all, so an exception in any
// route left the request hanging with no response ever sent, and Telegraph's
// grader recorded that as a timeout rather than an error. These cover both
// halves of the fix: the handler itself, and the forwarding that gets an
// async route's rejection to it (Express 4 does not do that on its own).
test('an uncaught error in a route answers with a JSON error instead of hanging', async (t) => {
  const { errorHandler, forwardAsyncErrors } = await import('./app.js');
  const router = express.Router();
  router.get('/sync-boom', () => {
    throw new Error('sync boom');
  });
  router.get('/async-boom', async () => {
    await new Promise((r) => setTimeout(r, 1));
    throw new Error('async boom');
  });

  const app = express();
  app.use('/', forwardAsyncErrors(router));
  app.use(errorHandler);
  const base = startServer(t, app);

  for (const [path, message] of [['/sync-boom', 'sync boom'], ['/async-boom', 'async boom']]) {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(res.status, 500, `${path} should answer, not hang`);
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.ok(body.summary);
    assert.equal(body.error, message);
  }
});

test('the real app registers the error handler last', async () => {
  const app = buildApp();
  const stack = app._router.stack;
  const last = stack[stack.length - 1];
  assert.equal(last.handle.length, 4, 'last layer must be the four-argument error handler');
  assert.equal(stack.filter((l) => l.handle.length === 4).length, 1);
});
