import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forwardAsyncErrors, errorHandler } from '../app.js';
import router from './checkSportsScore.js';
import { __clearSportsCacheForTesting } from '../lib/sportsData.js';

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
