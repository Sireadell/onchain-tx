import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkSportsScore.js';
import { __clearSportsCacheForTesting } from '../lib/sportsData.js';
import { __clearEspnCacheForTesting } from '../lib/espnScores.js';
import { espnAnswer } from './checkSportsScore.js';

// ESPN is answered from this table for every test, so no test reaches the
// real site. Empty by default, which sends the route on to TheSportsDB.
let espnStub = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const str = String(url);
  if (str.startsWith('https://site.api.espn.com/')) {
    const path = str.replace('https://site.api.espn.com/apis/site/v2/sports/', '').split('?')[0];
    const body = espnStub[path] ?? (path.endsWith('/teams') ? { sports: [{ leagues: [{ teams: [] }] }] } : { events: [] });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};
function setEspn(t, table) {
  __clearEspnCacheForTesting();
  espnStub = table;
  t.after(() => { espnStub = {}; __clearEspnCacheForTesting(); });
}

const team = (id, displayName, shortDisplayName, nickname) => ({ team: { id, displayName, shortDisplayName, name: shortDisplayName, nickname, location: displayName, abbreviation: id } });
const espnEvent = (id, date, home, away, hs, as, state) => ({
  id, date, league: { name: 'English Premier League' },
  competitions: [{
    venue: { fullName: 'Anfield' },
    status: { type: { state, completed: state === 'post', detail: state === 'post' ? 'FT' : state === 'in' ? "67'" : 'Scheduled' } },
    competitors: [
      { homeAway: 'home', team: { id: home[0], displayName: home[1] }, score: hs === null ? undefined : { value: hs } },
      { homeAway: 'away', team: { id: away[0], displayName: away[1] }, score: as === null ? undefined : { value: as } },
    ],
  }],
});
const MU = ['360', 'Manchester United'];
const LIV = ['364', 'Liverpool'];
const EPL_TEAMS = { sports: [{ leagues: [{ teams: [team('360', 'Manchester United', 'Man United', 'Red Devils'), team('364', 'Liverpool', 'Liverpool', 'Reds'), team('382', 'Manchester City', 'Man City', 'City')] }] }] };

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/sports-score', forwardAsyncErrors(router));
  app.use(errorHandler);
  return app;
}

function startServer(t) {
  const server = buildTestApp().listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function stubSportsDb(t, { teams, lastEvents, nextEvents } = {}) {
  __clearSportsCacheForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.includes('searchteams.php')) {
      return new Response(JSON.stringify({ teams: teams ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (str.includes('eventslast.php')) {
      return new Response(JSON.stringify({ results: lastEvents ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (str.includes('eventsnext.php')) {
      return new Response(JSON.stringify({ results: nextEvents ?? null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; __clearSportsCacheForTesting(); });
}

function withPerplexityKey(t) {
  const previous = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = 'test-key';
  t.after(() => {
    if (previous === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = previous;
  });
}

function stubPerplexity(t, { status = 200, content = 'Team A won 3-1.' } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://api.perplexity.ai')) {
      return new Response(JSON.stringify({ output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }], search_results: [] }), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
}

const LAKERS_TEAM = [{ idTeam: '134880', strTeam: 'Los Angeles Lakers', strLeague: 'NBA', strSport: 'Basketball', strCountry: 'USA' }];
const FINISHED_EVENT = [{
  idEvent: '1', strLeague: 'NBA', strSeason: '2025-2026', dateEvent: '2026-09-15', strTime: '19:00:00',
  strStatus: 'Match Finished', strHomeTeam: 'Los Angeles Lakers', strAwayTeam: 'Golden State Warriors',
  intHomeScore: '110', intAwayScore: '104', strVenue: 'Crypto.com Arena',
}];

test('SPORTS_SCORE happy path reports a finished score', async (t) => {
  const base = startServer(t);
  stubSportsDb(t, { teams: LAKERS_TEAM, lastEvents: FINISHED_EVENT, nextEvents: null });
  const res = await fetch(`${base}/sports-score?team=Lakers`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.match(json.summary, /Los Angeles Lakers 110 - 104 Golden State Warriors/);
});

test('SPORTS_SCORE derives team from a whole question', async (t) => {
  const base = startServer(t);
  stubSportsDb(t, { teams: LAKERS_TEAM, lastEvents: FINISHED_EVENT, nextEvents: null });
  const res = await fetch(`${base}/sports-score?question=${encodeURIComponent('What is the score of the Lakers game?')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.match(json.summary, /Lakers/);
});

test('SPORTS_SCORE falls back to web search when team is unknown to TheSportsDB', async (t) => {
  const base = startServer(t);
  stubSportsDb(t, { teams: null, lastEvents: null, nextEvents: null });
  withPerplexityKey(t);
  stubPerplexity(t, { content: 'The Obscure Rovers beat Nowhere FC 2-0 in their most recent match.' });
  const res = await fetch(`${base}/sports-score?team=${encodeURIComponent('Obscure Rovers')}`);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.degraded, true);
  assert.match(json.summary, /Obscure Rovers/);
});

test('SPORTS_SCORE missing team refuses with 200, not 4xx', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/sports-score`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('SPORTS_SCORE unknown team with no search provider refuses honestly', async (t) => {
  const base = startServer(t);
  stubSportsDb(t, { teams: null, lastEvents: null, nextEvents: null });
  const res = await fetch(`${base}/sports-score?team=${encodeURIComponent('Zzzznonexistentteamxyz')}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'invalid_input');
});

test('SPORTS_SCORE handles a 12,000+ char input without crashing', async (t) => {
  const base = startServer(t);
  stubSportsDb(t, { teams: null, lastEvents: null, nextEvents: null });
  const long = 'a'.repeat(12_500);
  const res = await fetch(`${base}/sports-score?team=${encodeURIComponent(long)}`);
  assert.equal(res.status, 200);
});

test('SPORTS_SCORE upstream and fallback both down returns a real error code', async (t) => {
  const base = startServer(t);
  __clearSportsCacheForTesting();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('http://127.0.0.1')) return original(url, init);
    throw new Error('network down');
  };
  t.after(() => { globalThis.fetch = original; });
  withPerplexityKey(t);
  const res = await fetch(`${base}/sports-score?team=Lakers`);
  const json = await res.json();
  assert.equal(res.status, 502);
  assert.equal(json.status, 'error');
});

test('SPORTS_SCORE POST works the same as GET', async (t) => {
  const base = startServer(t);
  stubSportsDb(t, { teams: LAKERS_TEAM, lastEvents: FINISHED_EVENT, nextEvents: null });
  const res = await fetch(`${base}/sports-score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team: 'Lakers' }),
  });
  const json = await res.json();
  assert.equal(json.status, 'ok');
});

test('SPORTS_SCORE answers a "current score" match question with no live game from ESPN', async (t) => {
  const base = startServer(t);
  stubSportsDb(t, {});
  setEspn(t, {
    'soccer/eng.1/teams': EPL_TEAMS,
    'soccer/eng.1/teams/360/schedule': { events: [
      espnEvent('1', '2026-05-03T14:30Z', MU, LIV, 3, 2, 'post'),
      espnEvent('2', '2026-11-08T16:30Z', MU, ['362', 'Aston Villa'], 4, 4, 'post'),
      espnEvent('3', '2099-11-22T16:30Z', LIV, MU, null, null, 'pre'),
    ] },
  });
  const q = 'What is the current score of the Manchester United vs. Liverpool match?';
  const json = await (await fetch(`${base}/sports-score?query=${encodeURIComponent(q)}`)).json();
  assert.equal(json.status, 'ok');
  assert.equal(json.team, 'Manchester United');
  assert.equal(json.opponent, 'Liverpool');
  assert.equal(json.live, false);
  assert.match(json.summary, /no live score right now/);
  assert.match(json.summary, /next match is Liverpool vs Manchester United/);
  assert.match(json.summary, /most recent meeting ended Manchester United 3-2 Liverpool/);
  assert.match(json.summary, /latest result: Manchester United 4-4 Aston Villa/);
  assert.equal(json.last_meeting.home_score, 3);
});

test('SPORTS_SCORE reports a live score from the ESPN board first', async (t) => {
  const base = startServer(t);
  stubSportsDb(t, {});
  setEspn(t, {
    'soccer/eng.1/teams': EPL_TEAMS,
    'soccer/eng.1/scoreboard': { events: [espnEvent('9', new Date().toISOString(), LIV, MU, 1, 0, 'in')] },
  });
  const json = await (await fetch(`${base}/sports-score?home=Liverpool&away=${encodeURIComponent('Manchester United')}`)).json();
  assert.equal(json.live, true);
  assert.match(json.summary, /^Live now: Liverpool 1-0 Manchester United \(67'/);
  assert.equal(json.home_score, 1);
});

test('SPORTS_SCORE ESPN answer uses the right possessive for plural team names', () => {
  const ev = { home_team: 'A', away_team: 'B', home_score: 1, away_score: 0, date: '2026-01-01T00:00Z', competition: 'MLB', completed: true, state: 'post' };
  const out = espnAnswer({ team: 'New York Yankees', opponent: 'Boston Red Sox', league: 'MLB', sport: 'baseball', live: null, lastMeeting: null, nextMeeting: null, teamLast: ev, teamNext: null });
  assert.match(out.summary, /New York Yankees' latest result/);
});
