// SPORTS_SCORE and GAME_RESULT signal source, TheSportsDB's public test key
// ("3" in the URL path), no signup. Given a team name, finds the team, then
// its most recent event (finished or in progress) to report a score or
// result. TheSportsDB's coverage is real but uneven across leagues, so a
// team it cannot find falls through to the route's searchWeb fallback
// rather than being reported as "no such team".

const SPORTSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';
const REQUEST_TIMEOUT_MS = Number(process.env.SPORTSDB_TIMEOUT_MS) || 8_000;
const CACHE_TTL_MS = Number(process.env.SPORTSDB_CACHE_TTL_MS) || 3 * 60_000;
const MAX_CACHE_ENTRIES = 300;

export const SPORTSDB_ATTRIBUTION = 'Sports data from TheSportsDB (thesportsdb.com).';

export class SportsUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SportsUpstreamError';
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

const teamCache = new TtlCache();
const eventsCache = new TtlCache();

export function __clearSportsCacheForTesting() {
  teamCache.store.clear();
  eventsCache.store.clear();
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new SportsUpstreamError(`${label} returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch (err) {
      throw new SportsUpstreamError(`${label} returned unreadable JSON: ${err.message}`);
    }
  } catch (err) {
    if (err instanceof SportsUpstreamError) throw err;
    if (err.name === 'AbortError') throw new SportsUpstreamError(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new SportsUpstreamError(`${label} request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Finds the best-matching team by name. Returns null (not an error) when
// TheSportsDB simply has no team by that name, so the route can fall
// through to a web search instead of reporting an outage.
export async function findTeam(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return null;
  const cacheKey = trimmed.toLowerCase();
  const cached = teamCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const body = await fetchJson(`${SPORTSDB_BASE}/searchteams.php?t=${encodeURIComponent(trimmed)}`, 'TheSportsDB team search');
  const teams = Array.isArray(body?.teams) ? body.teams : [];
  // Prefer an exact (case-insensitive) name match; otherwise the first
  // result, which TheSportsDB already ranks by relevance.
  const exact = teams.find((t) => String(t.strTeam ?? '').toLowerCase() === cacheKey);
  const team = exact ?? teams[0] ?? null;
  const result = team ? {
    id: team.idTeam,
    name: team.strTeam,
    league: team.strLeague,
    sport: team.strSport,
    country: team.strCountry,
  } : null;
  teamCache.set(cacheKey, result, CACHE_TTL_MS);
  return result;
}

// The most recent event (finished, live, or upcoming) for a team, in that
// preference order: a caller asking for "the score" or "the result" almost
// always means the game already in progress or most recently completed,
// not a future fixture.
export async function latestEventForTeam(teamId) {
  const cacheKey = String(teamId);
  const cached = eventsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const [pastBody, nextBody] = await Promise.all([
    fetchJson(`${SPORTSDB_BASE}/eventslast.php?id=${encodeURIComponent(teamId)}`, 'TheSportsDB last events'),
    fetchJson(`${SPORTSDB_BASE}/eventsnext.php?id=${encodeURIComponent(teamId)}`, 'TheSportsDB next events').catch(() => null),
  ]);

  const past = Array.isArray(pastBody?.results) ? pastBody.results : [];
  const next = Array.isArray(nextBody?.results) ? nextBody.results : [];

  // Sort past events newest first (TheSportsDB does not guarantee order).
  const sortedPast = [...past].sort((a, b) => new Date(`${b.dateEvent}T${b.strTime || '00:00:00'}`) - new Date(`${a.dateEvent}T${a.strTime || '00:00:00'}`));

  const result = { mostRecent: sortedPast[0] ?? null, upcoming: next[0] ?? null };
  eventsCache.set(cacheKey, result, CACHE_TTL_MS);
  return result;
}

// Shapes a raw TheSportsDB event into the fields both SPORTS_SCORE and
// GAME_RESULT routes need, so neither route has to reach into the raw
// TheSportsDB field names itself.
export function shapeEvent(event) {
  if (!event) return null;
  const homeScore = event.intHomeScore !== null && event.intHomeScore !== undefined ? Number(event.intHomeScore) : null;
  const awayScore = event.intAwayScore !== null && event.intAwayScore !== undefined ? Number(event.intAwayScore) : null;
  const finished = Number.isFinite(homeScore) && Number.isFinite(awayScore);
  let winner = null;
  if (finished) {
    if (homeScore > awayScore) winner = event.strHomeTeam;
    else if (awayScore > homeScore) winner = event.strAwayTeam;
    else winner = 'draw';
  }
  return {
    event_id: event.idEvent,
    league: event.strLeague,
    season: event.strSeason,
    date: event.dateEvent,
    time: event.strTime || null,
    status: event.strStatus || (finished ? 'Match Finished' : 'Not Started'),
    home_team: event.strHomeTeam,
    away_team: event.strAwayTeam,
    home_score: homeScore,
    away_score: awayScore,
    finished,
    winner,
    venue: event.strVenue || null,
  };
}
