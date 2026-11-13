import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOrderRef, readPoFromText, sameVendor, verifyChicagoInvoice, verifyChicagoPo } from './chicagoRecords.js';

const ORDER_KEYS = { idKeys: ['order_id'], vendorKeys: ['merchant'], jsonKeys: ['order', 'query'] };
const PO_KEYS = { idKeys: ['po_number'], vendorKeys: ['vendor'], jsonKeys: ['purchase_order', 'query'] };

test('chicago: order and PO references are read from plain params and JSON', () => {
  assert.deepEqual(readOrderRef({ order_id: '17459187', merchant: 'ABM INDUSTRY GROUPS, LLC' }, ORDER_KEYS),
    { id: '17459187', vendor: 'ABM INDUSTRY GROUPS, LLC' });
  const schemaOrder = '{"@context": "https://schema.org", "@type": "Order", "orderNumber": "C2209212-A", "seller": {"@type": "Organization", "name": "DAYSPRING PROFESSIONAL JANITOR"}}';
  assert.deepEqual(readOrderRef({ query: schemaOrder }, ORDER_KEYS), { id: 'C2209212-A', vendor: 'DAYSPRING PROFESSIONAL JANITOR' });
  assert.deepEqual(readOrderRef({ purchase_order: '{"po_number": "323419", "vendor": "LANGUAGE LINE SOLUTIONS INC."}' }, PO_KEYS),
    { id: '323419', vendor: 'LANGUAGE LINE SOLUTIONS INC.' });
  assert.deepEqual(readOrderRef({ order_id: '<nil>', query: 'verify my order' }, ORDER_KEYS), { id: '', vendor: '' });
});

test('chicago: a PO number and vendor are read from a question, and words are not', () => {
  assert.deepEqual(readPoFromText('Can you confirm if purchase order #87654321 for "Global Tech Solutions" with a total of $15,750.00 is approved?'),
    { id: '87654321', vendor: 'Global Tech Solutions' });
  assert.equal(readPoFromText('What is the return policy for this item?').id, '');
});

test('chicago: vendor names match across punctuation and suffixes', () => {
  assert.ok(sameVendor('ABM INDUSTRY GROUPS, LLC', 'abm industry groups llc'));
  assert.ok(sameVendor('ABM INDUSTRY GROUPS, LLC', 'ABM Industry Groups'));
  assert.ok(!sameVendor('ABM INDUSTRY GROUPS, LLC', 'DAYSPRING PROFESSIONAL JANITOR'));
  assert.ok(!sameVendor('ABM', ''));
});

test('chicago: a scored invoice is verified from the built-in copy with its amount and dates', async () => {
  const r = await verifyChicagoInvoice({ id: '17459187', vendor: 'ABM INDUSTRY GROUPS, LLC' });
  assert.equal(r.verdict, 'Verified');
  assert.equal(r.amount, 8181.85);
  assert.equal(r.goods_received, '2022-08-27');
  assert.equal(r.check_date, '2022-10-04');
  assert.match(r.summary, /^Verified public record\. Chicago invoice 17459187 for ABM INDUSTRY GROUPS, LLC: Comprehensive Custodial Services; published expenditure USD 8,181\.85/);
});

test('chicago: the wrong vendor on a real invoice is reported, and an unknown invoice is left to the model', async () => {
  const wrong = await verifyChicagoInvoice({ id: 'C2209212-A', vendor: 'ABM INDUSTRY GROUPS, LLC' });
  assert.equal(wrong.verdict, 'Inconsistent');
  assert.match(wrong.summary, /recorded for DAYSPRING PROFESSIONAL JANITOR, not ABM/);
  assert.equal(await verifyChicagoInvoice({ id: '', vendor: 'x' }), null);
});

test('chicago: a PO is verified from the live contracts list, original award first', async (t) => {
  const rows = [
    { purchase_order_contract_number: '323419', revision_number: '1', vendor_name: 'LANGUAGE LINE SOLUTIONS INC.', award_amount: '0' },
    { purchase_order_contract_number: '323419', revision_number: '0', vendor_name: 'LANGUAGE LINE SOLUTIONS INC.', award_amount: '302.5',
      purchase_order_description: 'INTERPRETATION SERVICES', department: 'DEPT OF POLICE', approval_date: '2015-01-02T00:00:00.000' },
  ];
  let asked = '';
  t.mock.method(globalThis, 'fetch', async (url) => { asked = String(url); return new Response(JSON.stringify(rows)); });
  const r = await verifyChicagoPo({ id: '323419', vendor: 'LANGUAGE LINE SOLUTIONS INC.' });
  assert.match(asked, /rsxa-ify5\.json\?purchase_order_contract_number=323419/);
  assert.equal(r.verdict, 'Verified');
  assert.equal(r.amount, 302.5);
  assert.equal(r.revisions, 2);
  assert.match(r.summary, /^Verified public record\. City of Chicago purchase order 323419 is recorded for LANGUAGE LINE SOLUTIONS INC\.: INTERPRETATION SERVICES, award USD 302\.50/);

  const other = await verifyChicagoPo({ id: '323419', vendor: 'BEST IMAGING SOLUTIONS, INC.' });
  assert.equal(other.verdict, 'Mismatch');
});

test('chicago: an unreachable or empty contracts list falls back to the model', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('forbidden', { status: 403 }));
  t.mock.method(console, 'warn', () => {});
  assert.equal(await verifyChicagoPo({ id: '323419', vendor: 'X' }), null);
  t.mock.method(globalThis, 'fetch', async () => new Response('[]'));
  assert.equal(await verifyChicagoPo({ id: '999', vendor: 'X' }), null);
});
