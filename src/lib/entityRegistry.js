// CREDIT_SCORE_VERIFY signal, entity verification via GLEIF (Global Legal
// Entity Identifier Foundation registry), no key, no practical rate limit.
// GLEIF confirms whether a company holds a registered LEI (Legal Entity
// Identifier), its legal name, jurisdiction, and registration status. This
// is a real, if partial, proxy for "is this a genuine, registered
// business" but is NOT a credit score: GLEIF publishes no creditworthiness
// figure at all, so this endpoint is deliberately explicit that a numeric
// credit score is never invented here.

const GLEIF_URL = 'https://api.gleif.org/api/v1/lei-records';
const REQUEST_TIMEOUT_MS = Number(process.env.ENTITY_REGISTRY_TIMEOUT_MS) || 8_000;
const CACHE_TTL_MS = Number(process.env.ENTITY_REGISTRY_CACHE_TTL_MS) || 30 * 60_000;
const MAX_CACHE_ENTRIES = 300;

export const GLEIF_ATTRIBUTION = 'GLEIF (Global Legal Entity Identifier Foundation), the international registry of Legal Entity Identifiers, via its public API. LEI registration is not a credit score.';

export class EntityRegistryUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EntityRegistryUpstreamError';
  }
}

export class EntityRegistryLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EntityRegistryLookupError';
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

const lookupCache = new TtlCache();

export function __clearEntityRegistryCacheForTesting() {
  lookupCache.store.clear();
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: 'application/vnd.api+json' }, signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    if (err.name === 'AbortError') throw new EntityRegistryUpstreamError(`GLEIF timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new EntityRegistryUpstreamError(`GLEIF request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

function formatAddress(a) {
  if (!a) return null;
  const parts = [...(a.addressLines ?? []), a.city, a.region, a.postalCode, a.country].filter((x) => typeof x === 'string' && x.trim());
  return parts.length ? parts.join(', ') : null;
}

// Looks up `name` in GLEIF's LEI registry by legal name (fuzzy prefix
// match, GLEIF's own filter behavior). Returns { matches: [...] } where an
// empty array is a genuine "no registered LEI found" answer, not an error.
export async function lookupEntity(name, { fulltext = false } = {}) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new EntityRegistryLookupError('no company name supplied to look up');

  const cacheKey = `${fulltext ? 'ft:' : ''}${trimmed.toLowerCase()}`;
  const cached = lookupCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const params = new URLSearchParams({
    [fulltext ? 'filter[fulltext]' : 'filter[entity.legalName]']: trimmed,
    'page[size]': '5',
  });
  const url = `${GLEIF_URL}?${params.toString()}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new EntityRegistryUpstreamError(`GLEIF returned HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new EntityRegistryUpstreamError(`GLEIF returned unreadable JSON: ${err.message}`);
  }
  const records = Array.isArray(body?.data) ? body.data : [];
  const matches = records.map((r) => ({
    lei: r.id ?? null,
    legal_name: r.attributes?.entity?.legalName?.name ?? null,
    jurisdiction: r.attributes?.entity?.jurisdiction ?? null,
    legal_form: r.attributes?.entity?.legalForm?.id ?? null,
    registration_status: r.attributes?.registration?.status ?? null,
    entity_status: r.attributes?.entity?.status ?? null,
    headquarters_country: r.attributes?.entity?.headquartersAddress?.country ?? null,
    legal_address: formatAddress(r.attributes?.entity?.legalAddress),
    headquarters_address: formatAddress(r.attributes?.entity?.headquartersAddress),
    registered_as: r.attributes?.entity?.registeredAs ?? null,
    creation_date: r.attributes?.entity?.creationDate ?? null,
    initial_registration_date: r.attributes?.registration?.initialRegistrationDate ?? null,
    last_update_date: r.attributes?.registration?.lastUpdateDate ?? null,
  }));
  const result = { query: trimmed, matches };
  lookupCache.set(cacheKey, result, CACHE_TTL_MS);
  return result;
}
