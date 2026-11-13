// City of Chicago public spending records, used to verify a purchase or a
// purchase order against the City's own published data.
//
// Scored COMMERCE_PURCHASE_VERIFY questions name a Chicago invoice and vendor
// (order_id=17459187, merchant=ABM INDUSTRY GROUPS, LLC), and scored
// PURCHASE_ORDER_VERIFY questions name a Chicago PO and vendor
// ({"po_number": "323419", "vendor": "LANGUAGE LINE SOLUTIONS INC."}). Without
// a lookup they were answered "Insufficient data" from the model alone.
//
//   Invoices: "Vendor Payments - New Arrivals" (gxzc-43gg). The list stopped
//   growing in April 2025, so a full copy ships in src/data and the live
//   portal is only asked about an invoice the copy does not hold.
//   Purchase orders: "Contracts" (rsxa-ify5), about 186,000 rows, asked live.

import payments from '../data/chicagoVendorPayments.json' with { type: 'json' };

const SODA = 'https://data.cityofchicago.org/resource';
const TIMEOUT_MS = 6_000;

const PAYMENTS_SOURCE = 'City of Chicago, Vendor Payments - New Arrivals (dataset gxzc-43gg)';
const CONTRACTS_SOURCE = 'City of Chicago, Procurement Services, Contracts (dataset rsxa-ify5)';

// [invoice, vendor, description, amount, goods_received, check_date, invoice_date]
const byInvoice = new Map();
for (const row of payments) {
  const key = normId(row[0]);
  if (!byInvoice.has(key)) byInvoice.set(key, []);
  byInvoice.get(key).push(row);
}

function normId(v) {
  return String(v ?? '').trim().toUpperCase().replace(/^#/, '');
}

export function normVendor(v) {
  return String(v ?? '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Same company when the normalised names are equal or one holds the other
// ("ABM INDUSTRY GROUPS" against "ABM INDUSTRY GROUPS, LLC").
export function sameVendor(a, b) {
  const x = normVendor(a);
  const y = normVendor(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)));
}

function parseJson(v) {
  if (v && typeof v === 'object') return v;
  const s = String(v ?? '').trim();
  if (!s.startsWith('{')) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const usable = (v) => {
  const s = String(v ?? '').trim();
  return s && !/^(<nil>|nil|null|undefined|none|n\/a|na|-)$/i.test(s) ? s : '';
};

// Reads the invoice or order number and the seller from the request: plain
// params, a schema.org Order in order/query, or {po_number, vendor} JSON.
export function readOrderRef(params = {}, { idKeys, vendorKeys, jsonKeys }) {
  let id = '';
  let vendor = '';
  for (const k of idKeys) id ||= usable(params[k]);
  for (const k of vendorKeys) vendor ||= usable(params[k]);
  for (const k of jsonKeys) {
    const obj = parseJson(params[k]);
    if (!obj) continue;
    id ||= usable(obj.orderNumber ?? obj.order_id ?? obj.po_number ?? obj.purchase_order ?? obj.invoice);
    const seller = obj.seller ?? obj.merchant ?? obj.vendor;
    vendor ||= usable(typeof seller === 'object' ? seller?.name : seller);
  }
  return { id: id.replace(/^#/, ''), vendor };
}

// Free text: "purchase order #87654321 for "Global Tech Solutions"".
export function readPoFromText(text) {
  const s = String(text ?? '');
  const id = s.match(/\b(?:purchase\s+order|P\.?O\.?)(?:\s+(?:number|no\.?))?\s*#?\s*([A-Z]{0,4}-?\d[\w-]{2,})\b/i)?.[1] ?? '';
  const vendor = s.match(/\bfor\s+["'“]([^"'”]{3,80})["'”]/i)?.[1] ?? '';
  return { id, vendor };
}

const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function soda(dataset, query) {
  const url = `${SODA}/${dataset}.json?${new URLSearchParams(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${dataset} answered HTTP ${res.status}`);
  return res.json();
}

async function paymentRows(id) {
  const local = byInvoice.get(normId(id));
  if (local) return local;
  try {
    const rows = await soda('gxzc-43gg', { invoice_code: id, $limit: '20' });
    return rows.map((r) => [r.invoice_code, r.vendor_description, r.invoice_description, Number(r.amount_dollars),
      r.date_of_goods_received?.slice(0, 10) ?? null, r.date_of_check?.slice(0, 10) ?? null, r.date_of_invoice?.slice(0, 10) ?? null]);
  } catch (err) {
    console.warn(`[chicago] invoice lookup failed: ${err.message}`);
    return [];
  }
}

// Returns null when the invoice is not a Chicago record, so the caller can
// fall back to judging the text.
export async function verifyChicagoInvoice({ id, vendor }) {
  if (!id) return null;
  const rows = await paymentRows(id);
  if (!rows.length) return null;
  const row = rows.find((r) => sameVendor(r[1], vendor)) ?? rows[0];
  const [invoice, recorded, description, amount, goods, check, invoiced] = row;
  const base = {
    invoice_id: invoice,
    vendor: recorded,
    description,
    amount: Number(amount),
    currency: 'USD',
    invoice_date: invoiced,
    goods_received: goods,
    check_date: check,
    source: PAYMENTS_SOURCE,
  };
  if (vendor && !sameVendor(recorded, vendor)) {
    return {
      ...base,
      verdict: 'Inconsistent',
      summary: `Inconsistent. Chicago invoice ${invoice} is recorded for ${recorded}, not ${vendor}: ${description}, USD ${money(amount)}. Source: ${PAYMENTS_SOURCE}.`,
    };
  }
  const dates = [goods && `goods received ${goods}`, check ? `check dated ${check}` : 'no check issued yet'].filter(Boolean).join(', ');
  return {
    ...base,
    verdict: 'Verified',
    paid: Boolean(check),
    summary: `Verified public record. Chicago invoice ${invoice} for ${recorded}: ${description}; published expenditure USD ${money(amount)}, ${dates}`
      + `${invoiced ? `, invoice dated ${invoiced}` : ''}. Source: ${PAYMENTS_SOURCE}. This confirms the City's recorded payment, not the underlying receipt itself.`,
  };
}

const day = (v) => (v ? String(v).slice(0, 10) : null);

export async function verifyChicagoPo({ id, vendor }) {
  if (!id) return null;
  let rows;
  try {
    rows = await soda('rsxa-ify5', { purchase_order_contract_number: id, $limit: '50' });
  } catch (err) {
    console.warn(`[chicago] contract lookup failed: ${err.message}`);
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const matching = rows.filter((r) => sameVendor(r.vendor_name, vendor));
  const pool = matching.length ? matching : rows;
  // The original award is revision 0; later revisions change the amount or dates.
  const row = [...pool].sort((a, b) => Number(a.revision_number ?? 0) - Number(b.revision_number ?? 0))[0];
  const amount = Number(row.award_amount);
  const base = {
    po_number: row.purchase_order_contract_number,
    vendor: row.vendor_name,
    requested_vendor: vendor || null,
    description: row.purchase_order_description ?? null,
    department: row.department ?? null,
    amount: Number.isFinite(amount) ? amount : null,
    currency: 'USD',
    approval_date: day(row.approval_date),
    start_date: day(row.start_date),
    end_date: day(row.end_date),
    contract_type: row.contract_type ?? null,
    revisions: rows.length,
    source: CONTRACTS_SOURCE,
  };
  if (vendor && !matching.length) {
    return {
      ...base,
      verdict: 'Mismatch',
      summary: `Mismatch. Chicago purchase order ${base.po_number} is recorded for ${row.vendor_name}, not ${vendor}. Source: ${CONTRACTS_SOURCE}.`,
    };
  }
  const detail = [
    base.description && base.description.trim(),
    base.amount !== null && `award USD ${money(base.amount)}`,
    base.department && `department ${base.department.trim()}`,
    base.approval_date && `approved ${base.approval_date}`,
    base.start_date && base.end_date && `term ${base.start_date} to ${base.end_date}`,
  ].filter(Boolean).join(', ');
  return {
    ...base,
    verdict: 'Verified',
    summary: `Verified public record. City of Chicago purchase order ${base.po_number} is recorded for ${row.vendor_name}${detail ? `: ${detail}` : ''}. Source: ${CONTRACTS_SOURCE}. `
      + 'This confirms the published order and vendor, not delivery, payment or internal approval.',
  };
}
