// ROUTE_ETA signal source, OSRM's public demo routing server, no key.
// Given two points, returns driving distance and duration. This is a shared
// public demo instance (the same one behind competing miners like
// route-osrm-lon-par in the live registry, 2026-09-17): treat rate limits
// and downtime as infrastructure, not a code defect, the same way
// weatherForecast.js treats Open-Meteo's shared-IP rate limiting.
//
// The demo server only reliably supports the "driving" profile; walking and
// cycling are not guaranteed to be available on it, so a request for either
// is answered honestly rather than silently substituted with a driving ETA.

const OSRM_BASE = 'https://router.project-osrm.org/route/v1';
const REQUEST_TIMEOUT_MS = Number(process.env.OSRM_TIMEOUT_MS) || 12_000;
const CACHE_TTL_MS = Number(process.env.OSRM_CACHE_TTL_MS) || 5 * 60_000;
const MAX_CACHE_ENTRIES = 300;

export const OSRM_ATTRIBUTION = 'Routing data from OSRM (Open Source Routing Machine), OpenStreetMap contributors, via the public router.project-osrm.org demo server.';

export const SUPPORTED_PROFILES = new Set(['driving']);

export class RoutingLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoutingLookupError';
  }
}

export class RoutingUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoutingUpstreamError';
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

const routeCache = new TtlCache();

export function __clearRoutingCacheForTesting() {
  routeCache.store.clear();
}

function round(n) {
  return Math.round(n * 10_000) / 10_000;
}

// origin/destination are { latitude, longitude }. Returns
// { distance_m, distance_km, duration_s, duration_min }.
export async function fetchRoute(origin, destination, profile = 'driving') {
  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new RoutingLookupError(`the '${profile}' travel mode is not reliably available on the public routing server; only driving is supported`);
  }
  const cacheKey = `${profile}|${round(origin.latitude)},${round(origin.longitude)};${round(destination.latitude)},${round(destination.longitude)}`;
  const cached = routeCache.get(cacheKey);
  if (cached) return cached;

  const coords = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
  // steps=true so a route that crosses open water shows it honestly. OSRM's
  // demo server has no drivable link across, say, the English Channel, and
  // will silently route through a real cross-Channel ferry (Portsmouth to
  // Cherbourg on a London-to-Paris query, confirmed live 2026-09-17: a real
  // 6-hour crossing, not a bug) rather than the tunnel shuttle it does not
  // model as a road. Reporting a bare "12 hours" with full confidence would
  // be a true number for a real way to make the trip, but a misleading
  // answer to what a person actually means by "how long to drive".
  const url = `${OSRM_BASE}/${profile}/${coords}?overview=false&steps=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err.name === 'AbortError') throw new RoutingUpstreamError(`OSRM timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new RoutingUpstreamError(`OSRM request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) throw new RoutingUpstreamError('OSRM demo server is rate limiting us');
  if (!res.ok) throw new RoutingUpstreamError(`OSRM returned HTTP ${res.status}`);

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new RoutingUpstreamError(`OSRM returned unreadable JSON: ${err.message}`);
  }

  if (body.code !== 'Ok' || !Array.isArray(body.routes) || !body.routes.length) {
    throw new RoutingLookupError(`OSRM could not find a route between the two points (${body.code ?? 'no route'})`);
  }

  const route = body.routes[0];
  const steps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []);
  const ferrySteps = steps.filter((step) => step.mode && step.mode !== profile);
  const ferry = ferrySteps.length
    ? {
      duration_s: ferrySteps.reduce((sum, s) => sum + (s.duration ?? 0), 0),
      distance_m: ferrySteps.reduce((sum, s) => sum + (s.distance ?? 0), 0),
      names: [...new Set(ferrySteps.map((s) => s.name).filter(Boolean))],
    }
    : null;

  const result = {
    distance_m: route.distance,
    distance_km: Number((route.distance / 1000).toFixed(2)),
    duration_s: route.duration,
    duration_min: Number((route.duration / 60).toFixed(1)),
    profile,
    ferry,
    fetchedAt: new Date().toISOString(),
  };
  routeCache.set(cacheKey, result, CACHE_TTL_MS);
  return result;
}
