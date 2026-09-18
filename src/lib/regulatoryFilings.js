// REGULATORY_FILING_MONITOR signal, live US federal regulatory filings and
// notices via the Federal Register API (no key, no practical rate limit).
// Chosen because it is a real, keyless, full-text-searchable government
// source of actual filed/published regulatory documents, which is what a
// question like "Will FDA fine B. Braun?" or "Will FDA issue a warning for
// Ioversol?" is really asking about: what has actually been filed or
// published, not a prediction of future agency action. This endpoint never
// predicts; it reports what already exists in the public record.

const FEDERAL_REGISTER_URL = 'https://www.federalregister.gov/api/v1/documents.json';
const REQUEST_TIMEOUT_MS = Number(process.env.REGULATORY_TIMEOUT_MS) || 8_000;
const CACHE_TTL_MS = Number(process.env.REGULATORY_CACHE_TTL_MS) || 15 * 60_000;
const MAX_CACHE_ENTRIES = 300;

export const FEDERAL_REGISTER_ATTRIBUTION = 'Federal Register (federalregister.gov), the official daily journal of the US federal government, via its public API.';

// Federal Register itself could not be reached or returned something
// unreadable. TxLens's fault, real error code.
export class RegulatoryUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegulatoryUpstreamError';
  }
}

// The caller supplied nothing searchable. Caller's problem, invalid_input.
export class RegulatoryLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegulatoryLookupError';
  }
}

class TtlCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      this.store.delete(this.store.keys().next().value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

const searchCache = new TtlCache();

export function __clearRegulatoryCacheForTesting() {
  searchCache.store.clear();
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    if (err.name === 'AbortError') throw new RegulatoryUpstreamError(`Federal Register timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new RegulatoryUpstreamError(`Federal Register request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const MAX_RESULTS = 5;

// Searches Federal Register full text for `query` (a company, product,
// drug, device, or industry term) and returns the most relevant recent
// documents. Cached briefly per normalized query so a burst of similar
// questions costs one real request.
export async function searchRegulatoryFilings(query, perPage = MAX_RESULTS) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new RegulatoryLookupError('no company, product, or concern supplied to search for');

  const cacheKey = `${trimmed.toLowerCase()}|${perPage}`;
  const cached = searchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const params = new URLSearchParams();
  params.set('conditions[term]', trimmed);
  params.set('per_page', String(Math.min(Math.max(perPage, 1), 10)));
  params.set('order', 'relevance');
  params.append('fields[]', 'title');
  params.append('fields[]', 'type');
  params.append('fields[]', 'abstract');
  params.append('fields[]', 'agencies');
  params.append('fields[]', 'publication_date');
  params.append('fields[]', 'html_url');
  params.append('fields[]', 'document_number');

  const url = `${FEDERAL_REGISTER_URL}?${params.toString()}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new RegulatoryUpstreamError(`Federal Register returned HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new RegulatoryUpstreamError(`Federal Register returned unreadable JSON: ${err.message}`);
  }
  const results = Array.isArray(body?.results) ? body.results : [];
  const documents = results.map((doc) => ({
    title: doc.title ?? null,
    type: doc.type ?? null,
    abstract: doc.abstract ?? null,
    agencies: Array.isArray(doc.agencies) ? doc.agencies.map((a) => a.name ?? a.raw_name).filter(Boolean) : [],
    publication_date: doc.publication_date ?? null,
    url: doc.html_url ?? null,
    document_number: doc.document_number ?? null,
  }));
  const result = {
    query: trimmed,
    total_matches: Number(body?.count) || documents.length,
    documents,
  };
  searchCache.set(cacheKey, result, CACHE_TTL_MS);
  return result;
}
