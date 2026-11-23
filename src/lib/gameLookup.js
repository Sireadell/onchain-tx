// Looks up one finished (or live, or upcoming) game from a plain question,
// using only free feeds that need no key: ESPN's public scoreboards by date
// (MLB, NHL, NFL, NBA, WNBA, the big football leagues, international finals)
// and the OpenLigaDB record for German league matches. Handles the question
// shapes the scorer asks: two teams plus a date, a match id, a named final
// ("the 2023 Super Bowl", "2022 FIFA World Cup final", "2023 World Series
// Game 7"), or one team on its own. Says plainly when no such game exists.

import { ESPN_LEAGUES, ESPN_BASE, leagueTeams, getJson, normName, scoresFor } from './espnScores.js';
import { openLigaMatchId, resolveOpenLigaCondition } from './openLigaDb.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');

// ---- reading the question ------------------------------------------------

export function parseDate(text) {
  const t = String(text ?? '');
  let m = /\b(20\d{2}|19\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?,?\s+(\d{4})\b/i.exec(t);
  if (m) return fromParts(m[3], m[2], m[1]);
  m = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(t);
  if (m) return fromParts(m[3], m[1], m[2]);
  m = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(t);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

function fromParts(year, monthWord, day) {
  const key = String(monthWord).toLowerCase().slice(0, 3);
  const idx = MONTHS.findIndex((x) => x.startsWith(key));
  if (idx < 0) return null;
  return `${year}-${pad(idx + 1)}-${pad(day)}`;
}

const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100 };
export function romanToInt(s) {
  let total = 0;
  const up = String(s).toUpperCase();
  for (let i = 0; i < up.length; i += 1) {
    const v = ROMAN[up[i]];
    if (!v) return null;
    total += v < (ROMAN[up[i + 1]] ?? 0) ? -v : v;
  }
  return total;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Days between two ISO dates, inclusive list.
function dayList(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const compact = (iso) => iso.replace(/-/g, '');

// ---- named finals ----------------------------------------------------------

const FINAL_DATES = {
  'fifa.world': { 2026: '2026-07-19', 2022: '2022-12-18', 2018: '2018-07-15', 2014: '2014-07-13', 2010: '2010-07-11', 2006: '2006-07-09' },
  'fifa.wwc': { 2023: '2023-08-20', 2019: '2019-07-07', 2015: '2015-07-05' },
  'uefa.euro': { 2024: '2024-07-14', 2021: '2021-07-11', 2016: '2016-07-10' },
  'uefa.champions': { 2025: '2025-05-31', 2024: '2024-06-01', 2023: '2023-06-10', 2022: '2022-05-28', 2021: '2021-05-29', 2019: '2019-06-01', 2018: '2018-05-26' },
  'conmebol.america': { 2024: '2024-07-14', 2021: '2021-07-10', 2019: '2019-07-07' },
};

// Each entry: how to spot it, the ESPN feed, which days to scan for a year,
// and the words ESPN puts in the game note.
const FINALS = [
  { name: 'Super Bowl', re: /\bsuper\s*bowl\b/i, sport: 'football', league: 'nfl', hint: /super bowl/i,
    days: (y) => dayList(`${y}-01-25`, `${y}-02-20`).filter((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 0) },
  { name: 'World Series', re: /\bworld\s+series\b/i, sport: 'baseball', league: 'mlb', hint: /world series/i,
    days: (y) => dayList(`${y}-10-20`, `${y}-11-06`) },
  { name: 'Stanley Cup Final', re: /\bstanley\s+cup\b/i, sport: 'hockey', league: 'nhl', hint: /stanley cup/i,
    days: (y) => dayList(`${y}-05-25`, `${y}-06-30`) },
  { name: 'NBA Finals', re: /\bnba\s+(?:finals|championship)\b/i, sport: 'basketball', league: 'nba', hint: /finals/i,
    days: (y) => dayList(`${y}-06-01`, `${y}-06-25`) },
  { name: 'World Cup final', re: /\b(?:fifa\s+)?men'?s?\s+world\s+cup\b|\bfifa\s+world\s+cup\b|\bworld\s+cup\s+final\b/i, sport: 'soccer', league: 'fifa.world', hint: /final/i, single: true, skip: /women|cricket|rugby|t20/i },
  { name: "Women's World Cup final", re: /\bwomen'?s\s+world\s+cup\b/i, sport: 'soccer', league: 'fifa.wwc', hint: /final/i, single: true },
  { name: 'UEFA European Championship final', re: /\b(?:uefa\s+)?euro\s*(?:20\d\d)?\b|\beuropean\s+championship\b/i, sport: 'soccer', league: 'uefa.euro', hint: /final/i, single: true },
  { name: 'Champions League final', re: /\bchampions\s+league\s+final\b|\bucl\s+final\b/i, sport: 'soccer', league: 'uefa.champions', hint: /final/i, single: true },
  { name: 'Copa America final', re: /\bcopa\s+am[eé]rica\b/i, sport: 'soccer', league: 'conmebol.america', hint: /final/i, single: true },
];

export function detectFinal(text) {
  const t = String(text ?? '');
  for (const f of FINALS) {
    if (f.skip && f.skip.test(t)) continue;
    if (f.re.test(t)) {
      const roman = /\bsuper\s*bowl\s+([IVXLC]+)\b/i.exec(t);
      let year = /\b(19\d{2}|20\d{2})\b/.exec(t)?.[1] ?? null;
      if (f.name === 'Super Bowl' && roman) year = String(1966 + romanToInt(roman[1]));
      const game = /\bgame\s+(\d)\b/i.exec(t)?.[1] ?? null;
      return { ...f, year: year ? Number(year) : null, game: game ? Number(game) : null };
    }
  }
  return null;
}

// ---- ESPN scoreboards by date ----------------------------------------------

const boardCache = new Map();
async function boardOn(sport, league, iso) {
  const key = `${sport}/${league}/${iso}`;
  const hit = boardCache.get(key);
  if (hit && Date.now() < hit.exp) return hit.events;
  let events = [];
  try {
    const body = await getJson(`${ESPN_BASE}/${sport}/${league}/scoreboard?dates=${compact(iso)}&limit=300`);
    events = Array.isArray(body?.events) ? body.events : [];
  } catch {
    return [];
  }
  if (boardCache.size > 600) boardCache.delete(boardCache.keys().next().value);
  // A finished past day never changes; today's board moves.
  const old = iso < new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  boardCache.set(key, { events, exp: Date.now() + (old ? 6 * 3600_000 : 60_000) });
  return events;
}
export function __clearGameCacheForTesting() { boardCache.clear(); }

function shapeEspn(e, leagueLabel) {
  const c = e?.competitions?.[0];
  const home = c?.competitors?.find((x) => x.homeAway === 'home');
  const away = c?.competitors?.find((x) => x.homeAway === 'away');
  if (!home || !away) return null;
  const num = (x) => {
    const n = Number(typeof x.score === 'object' ? x.score?.value : x.score);
    return Number.isFinite(n) && x.score !== '' && x.score != null ? n : null;
  };
  const st = c.status?.type ?? e.status?.type ?? {};
  const state = st.state || (st.completed ? 'post' : 'pre');
  const hs = state === 'pre' ? null : num(home);
  const as = state === 'pre' ? null : num(away);
  let winner = null;
  if (st.completed) {
    if (home.winner === true) winner = home.team.displayName;
    else if (away.winner === true) winner = away.team.displayName;
    else if (hs !== null && as !== null && hs !== as) winner = hs > as ? home.team.displayName : away.team.displayName;
  }
  return {
    id: e.id,
    date: e.date,
    day: String(e.date).slice(0, 10),
    competition: e.league?.name || leagueLabel,
    note: c.notes?.[0]?.headline || null,
    venue: c.venue?.fullName || null,
    home_team: home.team.displayName, away_team: away.team.displayName,
    home_id: home.team.id, away_id: away.team.id,
    home_score: hs, away_score: as,
    state, completed: Boolean(st.completed), winner,
    detail: st.detail || st.shortDetail || null,
    source: 'ESPN scoreboard (site.api.espn.com)',
  };
}

// ---- finding the teams named in a question ----------------------------------

let leagueIndexPromise = null;
async function leagueIndex() {
  if (!leagueIndexPromise) {
    leagueIndexPromise = Promise.all(ESPN_LEAGUES.map(async ([sport, league, label]) => ({ sport, league, label, teams: await leagueTeams(sport, league) })))
      .then((all) => {
        if (all.every((l) => l.teams.length === 0)) leagueIndexPromise = null; // upstream was down: try again next time
        return all;
      });
  }
  return leagueIndexPromise;
}

// Teams of one league that the text mentions. A full team name counts 3, a
// nickname or short name 2, a place name that only one team uses 1.
export function mentionsIn(textNorm, teams) {
  const padded = ` ${textNorm} `;
  const placeCount = new Map();
  for (const t of teams) {
    const place = t.aliases.at(-2);
    placeCount.set(place, (placeCount.get(place) ?? 0) + 1);
  }
  const found = [];
  for (const t of teams) {
    const full = normName(t.name);
    const aliases = [...new Set(t.aliases.filter((a) => a && a.length >= 4))];
    let best = 0;
    let pos = -1;
    for (const a of aliases) {
      const i = padded.indexOf(` ${a} `);
      if (i < 0) continue;
      const weight = a === full ? 3 : 2;
      if (weight > best || (weight === best && i < pos)) { best = weight; pos = i; }
    }
    if (!best) {
      // Location-only alias, only when no other team in the league shares it.
      for (const a of aliases) {
        if ((placeCount.get(a) ?? 0) === 1 && a !== full) {
          const i = padded.indexOf(` ${a} `);
          if (i >= 0) { best = 1; pos = i; break; }
        }
      }
    }
    if (best) found.push({ team: t, weight: best, pos });
  }
  // Drop a team whose only match sits inside a longer team's match span.
  found.sort((a, b) => a.pos - b.pos);
  return found;
}

export async function teamsInText(text) {
  const norm = normName(text);
  const index = await leagueIndex();
  let best = null;
  index.forEach((l, order) => {
    const found = mentionsIn(norm, l.teams);
    if (!found.length) return;
    const top = [...found].sort((a, b) => b.weight - a.weight).slice(0, 2).sort((a, b) => a.pos - b.pos);
    const rank = top.reduce((s, x) => s + x.weight, 0) + (top.length === 2 ? 10 : 0) - order * 0.01;
    if (!best || rank > best.rank) best = { rank, ...l, picked: top.map((x) => x.team) };
  });
  return best;
}

// ---- building the answer ----------------------------------------------------

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function dayLabel(g) {
  return g.day;
}

export function describeGame(g) {
  const where = g.note && g.competition && g.note.toLowerCase().includes(String(g.competition).toLowerCase()) ? g.note : [g.competition, g.note].filter(Boolean).join(', ');
  const venue = g.venue ? `, at ${g.venue}` : '';
  if (g.state === 'pre') {
    return { found: true, finished: false, line: `${g.away_team} at ${g.home_team} (${where}) is scheduled for ${dayLabel(g)} and has not been played yet, so there is no winner.` };
  }
  const score = `${g.home_team} ${g.home_score}-${g.away_score} ${g.away_team}`;
  if (g.state === 'in') {
    return { found: true, finished: false, line: `Game in progress, not final: ${score} (${g.detail || 'live'}) in ${where} on ${dayLabel(g)}.` };
  }
  if (g.winner) {
    const loser = g.winner === g.home_team ? g.away_team : g.home_team;
    const ws = g.winner === g.home_team ? g.home_score : g.away_score;
    const ls = g.winner === g.home_team ? g.away_score : g.home_score;
    const shoot = g.home_score === g.away_score && g.note ? ` (${g.note})` : '';
    return { found: true, finished: true, line: `Winner: ${g.winner}. ${g.winner} beat ${loser} ${ws}-${ls}${shoot} on ${dayLabel(g)} (${where}${venue}).` };
  }
  return { found: true, finished: true, line: `${g.home_team} and ${g.away_team} drew ${g.home_score}-${g.away_score} on ${dayLabel(g)} (${where}${venue}), so there was no winner.` };
}

function foundResult(g, extra = {}) {
  const d = describeGame(g);
  return {
    found: true,
    verdict: 'found',
    finished: d.finished,
    answer: d.line,
    winner: g.winner,
    home_team: g.home_team, away_team: g.away_team,
    home_score: g.home_score, away_score: g.away_score,
    date: g.day, competition: g.competition, venue: g.venue,
    source: g.source,
    ...extra,
  };
}

function notFound(reason, extra = {}) {
  return { found: false, verdict: 'not_found', answer: reason, reason, ...extra };
}

// ---- the lookups ------------------------------------------------------------

async function lookupFinal(fin, text, teamsHit) {
  const wanted = teamsHit?.picked ?? [];
  const asked = parseDate(text);
  const years = fin.year ? [fin.year, fin.year + 1, fin.year - 1] : [new Date().getUTCFullYear()];
  for (const y of years) {
    let days;
    if (fin.single) {
      const d = FINAL_DATES[fin.league]?.[y];
      if (!d) continue;
      days = [d];
    } else {
      days = fin.days(y);
    }
    const boards = await Promise.all(days.map((d) => boardOn(fin.sport, fin.league, d)));
    const games = boards.flat().map((e) => shapeEspn(e, fin.name)).filter(Boolean)
      .filter((g) => fin.hint.test(g.note ?? '') || (fin.single && fin.hint.test(g.competition ?? '')));
    if (!games.length) continue;
    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    let pool = games;
    if (wanted.length) {
      const ids = new Set(wanted.map((t) => t.id));
      const mine = games.filter((g) => ids.has(g.home_id) || ids.has(g.away_id));
      if (!mine.length) continue; // the named teams did not play that final: try the next year
      pool = mine;
    }
    const last = pool.at(-1);
    if (fin.game) {
      const g = pool.find((x) => new RegExp(`game\\s+${fin.game}\\b`, 'i').test(x.note ?? ''));
      if (g) return foundResult(g, { event: `${y} ${fin.name}, Game ${fin.game}` });
      const total = pool.length;
      const base = foundResult(last, { event: `${y} ${fin.name}` });
      return {
        ...base,
        answer: `There was no Game ${fin.game} in the ${y} ${fin.name}: it ended after ${total} games. Final game: ${base.answer}`,
        reason: `The series ended in ${total} games, so Game ${fin.game} was never played.`,
      };
    }
    const g = asked ? pool.find((x) => x.day === asked) ?? last : last;
    const base = foundResult(g, { event: `${y} ${fin.name}` });
    const gameNo = /game\s+(\d)/i.exec(g.note ?? '')?.[1];
    const seriesWord = !fin.single && g.winner && g === last
      ? `${g.winner} won the ${y} ${fin.name}${gameNo ? `, clinching it in Game ${gameNo}` : ''}. ` : '';
    return { ...base, answer: `${seriesWord}${base.answer}`.trim() };
  }
  return null;
}

async function lookupByDate(teamsHit, date) {
  const picked = teamsHit.picked;
  const ids = new Set(picked.map((t) => t.id));
  const both = picked.length === 2;
  for (const d of [date, addDays(date, 1), addDays(date, -1)]) {
    const events = (await boardOn(teamsHit.sport, teamsHit.league, d)).map((e) => shapeEspn(e, teamsHit.label)).filter(Boolean);
    const hit = events.filter((g) => (both ? ids.has(g.home_id) && ids.has(g.away_id) : ids.has(g.home_id) || ids.has(g.away_id)));
    if (hit.length) {
      for (const g of hit) g.day = d; // ESPN files a game under the local calendar day
      // A doubleheader shows several games: report them all, the first as the lead.
      const lead = foundResult(hit[0]);
      if (hit.length > 1) lead.answer = `${hit.length} games were played: ${hit.map((g) => describeGame(g).line).join(' ')}`;
      lead.games = hit.length;
      if (d !== date) lead.answer = `${lead.answer} (ESPN lists it on ${d}, a day off the date in the question, because of time zones.)`;
      return lead;
    }
  }
  return null;
}

// Both teams named but no date: their latest meeting, else the latest game.
async function lookupLatest(teamsHit) {
  const [a, b] = teamsHit.picked;
  const r = await scoresFor(a.name, b?.name ?? null);
  if (!r) return null;
  const g = r.live ?? r.lastMeeting ?? r.teamLast ?? r.nextMeeting ?? r.teamNext;
  if (!g) return null;
  const shaped = {
    id: g.event_id, day: String(g.date).slice(0, 10), date: g.date, competition: g.competition, venue: g.venue,
    home_team: g.home_team, away_team: g.away_team, home_score: g.home_score, away_score: g.away_score,
    state: g.state, completed: g.completed, detail: g.status_detail, note: null,
    winner: g.completed && g.home_score !== g.away_score ? (g.home_score > g.away_score ? g.home_team : g.away_team) : null,
    source: 'ESPN schedules (site.api.espn.com)',
  };
  return foundResult(shaped, { latest_only: true });
}

export async function lookupGame(text) {
  const q = clean(text);
  if (!q) return null;

  // 1. OpenLigaDB match id (German league records).
  if (openLigaMatchId(q)) {
    try {
      const r = await resolveOpenLigaCondition(q);
      if (r && r.finished) {
        const winnerLine = r.winner ? `${r.winner} won.` : 'The match was a draw.';
        return {
          found: true, verdict: 'found', finished: true,
          answer: `${r.home_team} ${r.score_home}-${r.score_away} ${r.away_team} on ${r.date} (${r.league}). ${winnerLine} Source record: ${r.source_url} (OpenLigaDB match ${r.match_id}).`,
          winner: r.winner, home_team: r.home_team, away_team: r.away_team,
          home_score: r.score_home, away_score: r.score_away, date: r.date, competition: r.league,
          source: 'OpenLigaDB', source_url: r.source_url,
        };
      }
      if (r) {
        return { found: true, verdict: 'found', finished: false, answer: r.summary, winner: null, home_team: r.home_team, away_team: r.away_team, date: r.date, competition: r.league, source: 'OpenLigaDB', source_url: r.source_url };
      }
    } catch { /* fall through to ESPN */ }
  }

  const teamsHit = await teamsInText(q).catch(() => null);
  const fin = detectFinal(q);
  const date = parseDate(q);

  // 2. A named final or championship.
  if (fin) {
    const r = await lookupFinal(fin, q, teamsHit).catch(() => null);
    if (r) return r;
  }

  // 3. Teams plus a date.
  if (teamsHit && date) {
    const r = await lookupByDate(teamsHit, date).catch(() => null);
    if (r) return r;
    const names = teamsHit.picked.map((t) => t.name).join(' and ');
    const latest = await lookupLatest(teamsHit).catch(() => null);
    const nearest = latest ? ` The closest game ESPN does list: ${latest.answer}` : '';
    return notFound(`No game involving ${names} is listed on ${date} in ESPN's ${teamsHit.label} scoreboards (checked that day and the days either side), so there is no result to report for that date.${nearest}`, { teams: names, date });
  }

  // 4. Teams, no date.
  if (teamsHit) {
    const r = await lookupLatest(teamsHit).catch(() => null);
    if (r) return r;
  }
  return null;
}

// Tournaments no free scoreboard covers (cricket, rugby, tennis, golf ...):
// the introduction of the encyclopedia page for the named event, cut down to
// the sentences that name the winner.
export async function wikiWinner(question) {
  const api = 'https://en.wikipedia.org/w/api.php';
  const headers = { 'User-Agent': 'TxLens/1.0 (telegraph miner)', Accept: 'application/json' };
  const terms = clean(question).replace(/^(who|which (?:team|side|player)|what)\s+(won|is|was|were)\s+(the\s+)?/i, '').replace(/[?!"]/g, '');
  const search = await getJson(`${api}?action=query&list=search&srsearch=${encodeURIComponent(terms)}&srlimit=3&format=json&origin=*`, { headers });
  const title = search?.query?.search?.[0]?.title;
  if (!title) return null;
  const page = await getJson(`${api}?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`, { headers });
  const text = Object.values(page?.query?.pages ?? {})[0]?.extract;
  if (!text) return null;
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z])/);
  const pick = sentences.filter((x) => /\b(won|winners?|champions?|defeated|beat|beating|title|triumph|clinched|retained)\b/i.test(x)).slice(0, 3);
  if (!pick.length) return null;
  return { title, text: pick.join(' '), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}` };
}
