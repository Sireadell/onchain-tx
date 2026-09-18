// SPORTS_SCORE signal endpoint. Given a team name, reports its most recent
// or in-progress match score via TheSportsDB (lib/sportsData.js). Falls
// back to a live web search when the team is not in TheSportsDB's coverage,
// same pattern as PACKAGE_STATUS and other no-authoritative-feed intents in
// this batch, so an honest best-effort answer still goes out rather than a
// refusal. Params seen on competing miners in the live registry
// (2026-09-17): team (sportwire-score), home/away/home_team/away_team/date
// (scorewire-oracle), question/query (both).

import { Router } from 'express';
import {
  findTeam, latestEventForTeam, shapeEvent, SportsUpstreamError, SPORTSDB_ATTRIBUTION,
} from '../lib/sportsData.js';
import { searchWeb, WebSearchError, hasWebSearchProvider } from '../lib/webSearch.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const TEAM_KEYS = ['team', 'home_team', 'home', 'club', 'franchise'];
const OPPONENT_KEYS = ['away_team', 'away', 'opponent'];
const QUESTION_KEYS = ['question', 'query', 'q', 'text', 'input'];
const MAX_INPUT_CHARS = 300;

// "the Lakers game", "Real Madrid vs Barcelona", "how did Liverpool do",
// pulls the most likely team name(s) out of a whole question. Deliberately
// shallow: this only has to beat "nothing", TheSportsDB's own fuzzy team
// search does the real matching.
const VS_RE = /\b([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})\s+(?:vs\.?|versus|v\.?|against)\s+([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3})\b/;
const TEAM_NOISE_RE = /\b(?:what|whats|what's|is|are|was|were|the|score|game|match|result|of|for|in|today|tonight|now|right|please|tell|me|give|show|current|latest|how|did|do|does|final)\b/gi;

function extractTeamFromQuestion(text) {
  const vsMatch = text.match(VS_RE);
  if (vsMatch) return { team: vsMatch[1].trim(), opponent: vsMatch[2].trim() };
  const cleaned = text.replace(TEAM_NOISE_RE, ' ').replace(/[?!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length >= 2 && cleaned.length <= 60) return { team: cleaned, opponent: null };
  return null;
}

function summarizeScore(team, shaped) {
  if (!shaped) return null;
  const { home_team: home, away_team: away, home_score: hs, away_score: as, finished, status, date } = shaped;
  if (finished) {
    return `${home} ${hs} - ${as} ${away} (final, ${date}).`;
  }
  if (Number.isFinite(hs) && Number.isFinite(as)) {
    return `${home} ${hs} - ${as} ${away} (${status || 'in progress'}, ${date}).`;
  }
  return `${home} vs ${away} is scheduled for ${date}${shaped.time ? ` at ${shaped.time}` : ''} and has not started yet.`;
}

async function handleSportsScore(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  const teamRaw = firstUsableValue(...TEAM_KEYS.map((k) => params[k]));
  const questionRaw = firstUsableValue(...QUESTION_KEYS.map((k) => params[k]));

  let teamName = typeof teamRaw === 'string' ? teamRaw.trim().slice(0, MAX_INPUT_CHARS) : null;
  let questionText = typeof questionRaw === 'string' ? questionRaw.trim().slice(0, MAX_INPUT_CHARS) : null;

  if (!teamName && questionText) {
    const derived = extractTeamFromQuestion(questionText);
    if (derived) teamName = derived.team;
  }

  if (!teamName) {
    return respondUnusableInput(
      res,
      'I cannot report a sports score because no team name was supplied. Pass a team parameter, e.g. team=Lakers.',
    );
  }

  let team;
  try {
    team = await findTeam(teamName);
  } catch (err) {
    if (!(err instanceof SportsUpstreamError)) throw err;
    // The provider itself is down; fall through to web search rather than
    // failing outright, since a best-effort answer beats none.
    team = null;
  }

  if (team) {
    try {
      const events = await latestEventForTeam(team.id);
      const chosen = events.mostRecent ?? events.upcoming;
      const shaped = shapeEvent(chosen);
      if (shaped) {
        return res.json({
          team: team.name,
          league: team.league,
          sport: team.sport,
          ...shaped,
          status: 'ok',
          summary: `${team.name} (${team.league}): ${summarizeScore(team.name, shaped)}`,
          confidence: shaped.finished ? 0.9 : 0.6,
          canonical: ['sports-score', team.name.toLowerCase().replace(/\s+/g, '-')].join(':'),
          source: 'TheSportsDB',
          attribution: SPORTSDB_ATTRIBUTION,
          checked_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      if (!(err instanceof SportsUpstreamError)) throw err;
      // Fall through to web search below.
    }
  }

  // TheSportsDB has no team by that name, or no event data for it. Try a
  // live web search rather than reporting the caller's input as unusable,
  // the team name itself may well be real, just outside this feed's
  // coverage (minor leagues, uncommon sports).
  if (!hasWebSearchProvider()) {
    return respondUnusableInput(
      res,
      `${quoteParam(teamName)} could not be found in the sports data feed, and no fallback search is configured.`,
    );
  }
  try {
    const query = `What is the current or most recent score for ${teamName}${questionText && questionText !== teamName ? ` (question: ${questionText})` : ''}?`;
    const result = await searchWeb(query, { topic: 'general', maxResults: 5 });
    if (!result.answer) {
      return respondUnusableInput(res, `No score information could be found for ${quoteParam(teamName)}.`);
    }
    return res.json({
      status: 'ok',
      summary: result.answer,
      confidence: 0.5,
      canonical: ['sports-score', teamName.toLowerCase().replace(/\s+/g, '-')].join(':'),
      team: teamName,
      source: `web search (${result.provider})`,
      degraded: true,
      results: result.results?.slice(0, 3) ?? [],
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof WebSearchError) {
      return res.status(502).json({
        status: 'error',
        summary: `The sports data feed and the fallback search are both unavailable for ${teamName}. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }
}

router.get('/', (req, res) => handleSportsScore(req, res));
router.post('/', (req, res) => handleSportsScore(req, res));

export default router;
