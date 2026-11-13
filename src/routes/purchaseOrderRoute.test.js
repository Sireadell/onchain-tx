import { test } from 'node:test';
import assert from 'node:assert/strict';

test('purchase order: a free-text purchase order question without a vendor reaches the model instead of crashing', async (t) => {
  const { default: express } = await import('express');
  const { purchaseOrderRouter } = await import('../routes/newIntents.js');
  const { forwardAsyncErrors, errorHandler } = await import('../app.js');
  const app = express();
  app.use('/po', forwardAsyncErrors(purchaseOrderRouter));
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/po?query=${encodeURIComponent('Please check that this purchase order matches the delivery note')}`);
  await res.text();
  assert.notEqual(res.status, 500);
});
