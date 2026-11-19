// SPORTS_SCORE source: ESPN's public site API (site.api.espn.com), no key.
// Team lists come from /teams per league, results and fixtures from a
// team's /schedule, and live games from the league /scoreboard. Used only
// by routes/checkSportsScore.js. TheSportsDB's old free key was switched
// off, so this is the main feed for named-team questions now.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const TIMEOUT_MS = Number(process.env.ESPN_TIMEOUT_MS) || 7_000;
const TEAMS_TTL_MS = 12 * 60 * 60_000;
const SCHEDULE_TTL_MS = 2 * 60_000;

export const ESPN_SOURCE = 'ESPN scoreboard and team schedules (site.api.espn.com)';

// [sport, league slug, display name]. Order matters only for ties: a name
// that fits teams in two leagues goes to the earlier one.
export const ESPN_LEAGUES = [
  ['soccer', 'eng.1', 'Premier League'],
  ['soccer', 'esp.1', 'LaLiga'],
  ['soccer', 'ger.1', 'Bundesliga'],
  ['soccer', 'ita.1', 'Serie A'],
  ['soccer', 'fra.1', 'Ligue 1'],
  ['soccer', 'usa.1', 'MLS'],
  ['soccer', 'eng.2', 'Championship'],
  ['soccer', 'ned.1', 'Eredivisie'],
  ['soccer', 'por.1', 'Primeira Liga'],
  ['soccer', 'sco.1', 'Scottish Premiership'],
  ['baseball', 'mlb', 'MLB'],
  ['basketball', 'nba', 'NBA'],
  ['football', 'nfl', 'NFL'],
  ['hockey', 'nhl', 'NHL'],
  ['basketball', 'wnba', 'WNBA'],
];

const cache = new Map();
function cached(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) { cache.delete(key); return undefined; }
  return hit.value;
}
function store(key, value, ttl) {
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  cache.set(key, { value, exp: Date.now() + ttl });
}
export function __clearEspnCacheForTesting() { cache.clear(); }

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ESPN returned HTTP ${res.status}`);
  return res.json();
}

export function normName(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ac|the)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function leagueTeams(sport, league) {
  const key = `teams:${sport}/${league}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  let teams = [];
  try {
    const body = await getJson(`${BASE}/${sport}/${league}/teams`);
    teams = (body?.sports?.[0]?.leagues?.[0]?.teams ?? []).map(({ team }) => ({
      id: team.id,
      name: team.displayName,
      aliases: [team.displayName, team.shortDisplayName, team.name, team.nickname, team.location, team.abbreviation]
        .filter(Boolean).map(normName),
    }));
    store(key, teams, TEAMS_TTL_MS);
  } catch {
    teams = [];
  }
  return teams;
}

// 3 = full name, 2 = a known alias ("Yankees", "Man Utd" is not one), 1 =
// every query word appears in the full name. 0 = no match.
export function matchScore(team, query) {
  const q = normName(query);
  if (!q) return 0;
  if (normName(team.name) === q) return 3;
  if (team.aliases.includes(q)) return 2;
  const words = q.split(' ');
  const full = ` ${normName(team.name)} `;
  if (words.every((w) => full.includes(` ${w} `))) return 1;
  return 0;
}

function bestIn(teams, query) {
  let best = null;
  let bestScore = 0;
  for (const t of teams) {
    const s = matchScore(t, query);
    if (s > bestScore) { best = t; bestScore = s; }
  }
  return best ? { team: best, score: bestScore } : null;
}

// Finds the league that holds the team (and the opponent, when one is
// named). A league holding both beats a stronger single-name match.
export async function findTeams(teamName, opponentName) {
  const lists = await Promise.all(ESPN_LEAGUES.map(([sport, league]) => leagueTeams(sport, league)));
  let pick = null;
  ESPN_LEAGUES.forEach(([sport, league, label], i) => {
    const a = bestIn(lists[i], teamName);
    if (!a) return;
    const b = opponentName ? bestIn(lists[i], opponentName) : null;
    const rank = a.score + (b ? b.score + 10 : 0);
    if (!pick || rank > pick.rank) pick = { rank, sport, league, label, team: a.team, opponent: b?.team ?? null };
  });
  return pick;
}

function shape(e, leagueLabel) {
  const c = e?.competitions?.[0];
  if (!c) return null;
  const home = c.competitors?.find((x) => x.homeAway === 'home');
  const away = c.competitors?.find((x) => x.homeAway === 'away');
  if (!home || !away) return null;
  const score = (x) => {
    const v = typeof x.score === 'object' ? (x.score?.value ?? x.score?.displayValue) : x.score;
    const n = Number(v);
    return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
  };
  const st = c.status?.type ?? e.status?.type ?? {};
  const state = st.state || (st.completed ? 'post' : 'pre');
  return {
    event_id: e.id,
    date: e.date,
    competition: e.league?.name || leagueLabel,
    venue: c.venue?.fullName || null,
    home_team: home.team?.displayName,
    away_team: away.team?.displayName,
    home_id: home.team?.id,
    away_id: away.team?.id,
    home_score: state === 'pre' ? null : score(home),
    away_score: state === 'pre' ? null : score(away),
    state,
    completed: Boolean(st.completed),
    status_detail: st.detail || st.shortDetail || st.description || null,
  };
}

async function schedule(sport, league, teamId, query) {
  const url = `${BASE}/${sport}/${league}/teams/${teamId}/schedule${query ? `?${query}` : ''}`;
  const key = `sched:${url}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  let events = [];
  try {
    const body = await getJson(url);
    events = Array.isArray(body?.events) ? body.events : [];
    store(key, events, SCHEDULE_TTL_MS);
  } catch {
    events = [];
  }
  return events;
}

async function scoreboard(sport, league) {
  const key = `board:${sport}/${league}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  let events = [];
  try {
    const body = await getJson(`${BASE}/${sport}/${league}/scoreboard`);
    events = Array.isArray(body?.events) ? body.events : [];
    store(key, events, 60_000);
  } catch {
    events = [];
  }
  return events;
}

// Gathers every known game of the team (this season, last season, the
// postseason, upcoming fixtures and today's board) and picks:
//   live: a game of the team (against the opponent, if named) in progress now
//   lastMeeting / nextMeeting: finished and upcoming games between the two
//   teamLast: the team's own latest finished game
export async function scoresFor(teamName, opponentName, { now = new Date() } = {}) {
  const found = await findTeams(teamName, opponentName);
  if (!found) return null;
  const { sport, league, label, team, opponent } = found;
  const y = now.getUTCFullYear();
  const queries = ['', `season=${y - 1}`];
  if (sport === 'soccer') queries.push('fixture=true');
  else queries.push(`season=${y}&seasontype=2`, `season=${y}&seasontype=3`, `season=${y + 1}`);
  const lists = await Promise.all([
    ...queries.map((q) => schedule(sport, league, team.id, q)),
    scoreboard(sport, league),
  ]);
  const byId = new Map();
  for (const e of lists.flat()) {
    const s = shape(e, label);
    if (!s || (s.home_id !== team.id && s.away_id !== team.id)) continue;
    const prev = byId.get(s.event_id);
    // Keep the copy with the most progress (the board beats a stale schedule).
    const rankOf = (x) => (x.completed ? 2 : x.state === 'in' ? 1 : 0);
    if (!prev || rankOf(s) > rankOf(prev)) byId.set(s.event_id, s);
  }
  const all = [...byId.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
  const vsOpp = (s) => !opponent || s.home_id === opponent.id || s.away_id === opponent.id;
  const live = all.find((s) => s.state === 'in' && vsOpp(s)) ?? null;
  const done = all.filter((s) => s.completed);
  const upcoming = all.filter((s) => s.state === 'pre' && new Date(s.date) > new Date(now.getTime() - 3 * 3600_000));
  return {
    sport,
    league: label,
    team: team.name,
    opponent: opponent?.name ?? null,
    live,
    lastMeeting: opponent ? done.filter(vsOpp).at(-1) ?? null : null,
    nextMeeting: opponent ? upcoming.find(vsOpp) ?? null : null,
    teamLast: done.at(-1) ?? null,
    teamNext: upcoming[0] ?? null,
  };
}

export function lineOf(s) {
  if (!s) return '';
  const day = new Date(s.date).toUTCString().replace(/:\d\d GMT$/, ' UTC');
  if (s.home_score === null || s.away_score === null) {
    return `${s.home_team} vs ${s.away_team} (${s.competition}${s.venue ? `, ${s.venue}` : ''}), ${day}`;
  }
  return `${s.home_team} ${s.home_score}-${s.away_score} ${s.away_team} (${s.competition}${s.venue ? `, ${s.venue}` : ''}, ${day})`;
}
