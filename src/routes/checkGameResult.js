// GAME_RESULT signal endpoint. Given a team name, reports who won its most
// recently completed match via TheSportsDB (lib/sportsData.js, shared with
// SPORTS_SCORE, not forked). Framed around the winner rather than the score
// line, matching leader game-football-data (live registry, 2026-09-17).
// Falls back to a live web search when the team is outside TheSportsDB's
// coverage. Team-sports match outcomes are the default framing per the
// build brief; non-sports "game" questions (board games, video games) have
// no real traffic signal yet and are answered via the same web-search
// fallback rather than a dedicated path that would be pure guesswork.

import { Router } from 'express';
import {
  findTeam, latestEventForTeam, shapeEvent, SportsUpstreamError, SPORTSDB_ATTRIBUTION,
} from '../lib/sportsData.js';
import { searchWeb, WebSearchError, hasWebSearchProvider } from '../lib/webSearch.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';
import { lookupGame, wikiWinner } from '../lib/gameLookup.js';

const router = Router();

const TEAM_KEYS = ['team', 'home_team', 'home', 'club', 'franchise'];
const QUESTION_KEYS = ['question', 'query', 'q', 'text', 'input'];
const MAX_INPUT_CHARS = 300;

const VS_RE = /\b([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})\s+(?:vs\.?|versus|v\.?|against)\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})\b/;
const TEAM_NOISE_RE = /\b(?:who|what|whats|what's|won|win|winning|is|are|was|were|the|game|match|result|of|for|in|today|tonight|now|right|please|tell|me|give|show|current|latest|did|do|does|final)\b/gi;

function extractTeamFromQuestion(text) {
  const vsMatch = text.match(VS_RE);
  if (vsMatch) return { team: vsMatch[1].trim(), opponent: vsMatch[2].trim() };
  const cleaned = text.replace(TEAM_NOISE_RE, ' ').replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length >= 2 && cleaned.length <= 60) return { team: cleaned, opponent: null };
  return null;
}

function summarizeResult(team, shaped) {
  const { home_team: home, away_team: away, home_score: hs, away_score: as, date } = shaped;
  if (shaped.winner === 'draw') return `${home} and ${away} drew ${hs}-${as} on ${date}.`;
  const loser = shaped.winner === home ? away : home;
  const winnerScore = shaped.winner === home ? hs : as;
  const loserScore = shaped.winner === home ? as : hs;
  return `${shaped.winner} beat ${loser} ${winnerScore}-${loserScore} on ${date}.`;
}

async function handleGameResult(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  const teamRaw = firstUsableValue(...TEAM_KEYS.map((k) => params[k]));
  const questionRaw = firstUsableValue(...QUESTION_KEYS.map((k) => params[k]));

  let teamName = typeof teamRaw === 'string' ? teamRaw.trim().slice(0, MAX_INPUT_CHARS) : null;
  const questionText = typeof questionRaw === 'string' ? questionRaw.trim().slice(0, MAX_INPUT_CHARS) : null;

  // Free official feeds first (ESPN by date, finals, OpenLigaDB). They settle
  // dated games, named finals and plain team questions without any paid key.
  const askText = [questionText, !questionText ? teamName : null].filter(Boolean).join(' ');
  if (askText) {
    let found = null;
    try {
      found = await lookupGame(askText);
    } catch {
      found = null;
    }
    if (found) {
      const { answer, ...rest } = found;
      return res.json({
        status: 'ok',
        answer,
        summary: answer,
        reason: found.found ? `Read from ${found.source}.` : answer,
        confidence: found.found ? (found.finished === false ? 0.7 : 0.95) : 0.85,
        canonical: ['game-result', askText.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)].join(':'),
        ...rest,
        checked_at: new Date().toISOString(),
      });
    }
    // Tournaments no free scoreboard covers (cricket, rugby, tennis ...): the
    // encyclopedia page for the named event, labelled as such.
    if (/\b(19|20)\d{2}\b/.test(askText) && /\b(who|which|won|winner|champion|final)\b/i.test(askText)) {
      try {
        const wiki = await wikiWinner(askText);
        if (wiki?.text) {
          const answer = `${wiki.text} (Source: Wikipedia, "${wiki.title}".)`;
          return res.json({
            status: 'ok', answer, summary: answer, verdict: 'found', found: true,
            reason: 'Read from the encyclopedia page for this event; no live scoreboard covers it.',
            confidence: 0.7, canonical: ['game-result', wiki.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')].join(':'),
            source: wiki.url, checked_at: new Date().toISOString(),
          });
        }
      } catch { /* continue */ }
    }
  }

  if (!teamName && questionText) {
    const derived = extractTeamFromQuestion(questionText);
    if (derived) teamName = derived.team;
  }

  if (!teamName) {
    return respondUnusableInput(
      res,
      'I cannot report a game result because no team name was supplied. Pass a team parameter, e.g. team=Knicks.',
    );
  }

  let team;
  try {
    team = await findTeam(teamName);
  } catch (err) {
    if (!(err instanceof SportsUpstreamError)) throw err;
    team = null;
  }

  if (team) {
    try {
      const events = await latestEventForTeam(team.id);
      const shaped = shapeEvent(events.mostRecent);
      if (shaped && shaped.finished) {
        return res.json({
          team: team.name,
          league: team.league,
          sport: team.sport,
          ...shaped,
          status: 'ok',
          summary: `${team.name} (${team.league}): ${summarizeResult(team.name, shaped)}`,
          confidence: 0.9,
          canonical: ['game-result', team.name.toLowerCase().replace(/\s+/g, '-')].join(':'),
          source: 'TheSportsDB',
          attribution: SPORTSDB_ATTRIBUTION,
          checked_at: new Date().toISOString(),
        });
      }
      if (shaped && !shaped.finished) {
        return res.json({
          team: team.name,
          league: team.league,
          ...shaped,
          status: 'ok',
          summary: `${team.name}'s most recent listed match (${shaped.home_team} vs ${shaped.away_team}, ${shaped.date}) has not finished or has no recorded score yet.`,
          confidence: 0.4,
          canonical: ['game-result', team.name.toLowerCase().replace(/\s+/g, '-')].join(':'),
          source: 'TheSportsDB',
          attribution: SPORTSDB_ATTRIBUTION,
          checked_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      if (!(err instanceof SportsUpstreamError)) throw err;
    }
  }

  const noData = (why) => res.json({
    status: 'ok',
    answer: why,
    summary: why,
    verdict: 'not_found',
    found: false,
    reason: why,
    confidence: 0.6,
    team: teamName,
    checked_at: new Date().toISOString(),
  });
  const plain = `No game result could be found for ${quoteParam(teamName)}. ESPN's scoreboards (MLB, NHL, NFL, NBA, WNBA and the main football leagues), OpenLigaDB and TheSportsDB were all checked and none lists a matching game. Send the two team names and the date and it is looked up directly.`;

  if (!hasWebSearchProvider()) return noData(plain);
  try {
    const query = `Who won the most recent game involving ${teamName}${questionText && questionText !== teamName ? ` (question: ${questionText})` : ''}? State the final score and winner.`;
    const result = await searchWeb(query, { topic: 'general', maxResults: 5 });
    if (!result.answer) return noData(plain);
    return res.json({
      status: 'ok',
      answer: result.answer,
      summary: result.answer,
      verdict: 'found',
      found: true,
      reason: `Read from a live web search (${result.provider}); no scoreboard feed listed the game.`,
      confidence: 0.5,
      canonical: ['game-result', teamName.toLowerCase().replace(/\s+/g, '-')].join(':'),
      team: teamName,
      source: `web search (${result.provider})`,
      degraded: true,
      results: result.results?.slice(0, 3) ?? [],
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof WebSearchError) return noData(plain);
    throw err;
  }
}

router.get('/', (req, res) => handleGameResult(req, res));
router.post('/', (req, res) => handleGameResult(req, res));

export default router;
