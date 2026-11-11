// FX_NOW rates: the ECB reference rate via Frankfurter first, then
// open.er-api.com (166 currencies, no key) for pairs the ECB does not carry.

import { convertCurrency, CurrencyLookupError, CurrencyUpstreamError } from './currencyExchange.js';

const ER_API_URL = 'https://open.er-api.com/v6/latest';
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60_000;
const tableCache = new Map();

export function __clearFxNowCacheForTesting() {
  tableCache.clear();
}

async function erApiTable(base) {
  const hit = tableCache.get(base);
  if (hit && Date.now() < hit.expiresAt) return hit.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${ER_API_URL}/${encodeURIComponent(base)}`, {
      headers: { Accept: 'application/json' }, signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.result !== 'success' || !body.rates) return null;
    const value = { rates: body.rates, updatedAt: body.time_last_update_utc ?? null };
    tableCache.set(base, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns { from, to, amount, rate, result, asOf, source }. Throws
// CurrencyLookupError when no source carries the pair, CurrencyUpstreamError
// when every source is unreachable.
export async function liveFxRate(from, to, amount = 1) {
  if (from === to) {
    return { from, to, amount, rate: 1, result: amount, asOf: new Date().toISOString(), source: 'identity' };
  }
  // ECB reference rate first: it is the rate the ranking checks against.
  let ecbMissing = false;
  try {
    const c = await convertCurrency(from, to, amount);
    return { from, to, amount, rate: c.rate, result: c.result, asOf: `${c.date}T00:00:00.000Z`, source: 'ECB reference rate (Frankfurter)' };
  } catch (err) {
    if (err instanceof CurrencyLookupError) ecbMissing = true;
  }
  const table = await erApiTable(from);
  const rate = table?.rates?.[to];
  if (Number.isFinite(rate)) {
    return {
      from, to, amount, rate, result: Number((amount * rate).toFixed(6)),
      asOf: table.updatedAt ? new Date(table.updatedAt).toISOString() : new Date().toISOString(),
      source: 'ExchangeRate-API (open.er-api.com)',
    };
  }
  if (ecbMissing || (table && !(to in table.rates))) {
    throw new CurrencyLookupError(`No live rate is published from ${from} to ${to}`);
  }
  throw new CurrencyUpstreamError('Every FX rate source is unavailable');
}
