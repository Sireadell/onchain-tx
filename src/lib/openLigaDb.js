// Settles football match conditions from OpenLigaDB (free, no key), the
// community record of German league results. Scored EVENT_OUTCOME questions
// name the OpenLigaDB match id ("OpenLigaDB match 72653") and ask whether a
// condition such as "1. FC Nürnberg wins this match outright at full time"
// or "was it a draw" held. A web search answered these from articles and
// once said a finished 2025 match was still "scheduled"; the record itself
// settles them exactly.

const API = 'https://api.openligadb.de/getmatchdata';
const TIMEOUT_MS = 6_000;

const MATCH_ID_RE = /\bopenligadb\s+match(?:\s+id)?\s*#?\s*(\d{4,7})\b/i;

export function openLigaMatchId(text) {
  const m = MATCH_ID_RE.exec(String(text ?? ''));
  return m ? m[1] : null;
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function mentions(text, team) {
  const t = ` ${norm(text)} `;
  return [team.teamName, team.shortName].filter(Boolean).some((n) => n.length > 2 && t.includes(` ${norm(n)} `));
}

// Which condition is asked: a named team winning, a draw, or (with nothing
// recognisable) just the result.
export function readCondition(text, match) {
  const t = String(text ?? '');
  const quoted = /['‘’"“”]([^'‘’"“”]{3,160})['‘’"“”]/.exec(t)?.[1] ?? t;
  if (/\bdraw\b|\bunentschieden\b|\btied?\b/i.test(quoted)) return { kind: 'draw' };
  if (/\bwins?\b|\bwinner\b|\bvictory\b|\bbeats?\b/i.test(quoted)) {
    const one = mentions(quoted, match.team1);
    const two = mentions(quoted, match.team2);
    if (one && !two) return { kind: 'win', team: 1 };
    if (two && !one) return { kind: 'win', team: 2 };
    // Both named ("A beats B" or "Jahn hosting Schalke"): the first named wins.
    if (one && two) {
      const q = norm(quoted);
      const i1 = Math.min(...[match.team1.teamName, match.team1.shortName].filter(Boolean).map((n) => q.indexOf(norm(n))).filter((i) => i >= 0));
      const i2 = Math.min(...[match.team2.teamName, match.team2.shortName].filter(Boolean).map((n) => q.indexOf(norm(n))).filter((i) => i >= 0));
      return { kind: 'win', team: i1 <= i2 ? 1 : 2 };
    }
  }
  return { kind: 'result' };
}

export async function fetchOpenLigaMatch(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/${id}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.matchID ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveOpenLigaCondition(text) {
  const id = openLigaMatchId(text);
  if (!id) return null;
  const match = await fetchOpenLigaMatch(id);
  if (!match) return null;
  const home = match.team1.teamName;
  const away = match.team2.teamName;
  const date = String(match.matchDateTimeUTC ?? match.matchDateTime ?? '').slice(0, 10);
  const where = `${home} vs ${away} on ${date} (${match.leagueName}, ${match.group?.groupName ?? 'matchday'}, OpenLigaDB match ${id})`;
  const condition = readCondition(text, match);
  const base = {
    match_id: Number(id), league: match.leagueName, date, home_team: home, away_team: away,
    source: 'OpenLigaDB', source_url: `${API}/${id}`,
  };
  if (!match.matchIsFinished) {
    return {
      ...base, outcome: 'unresolved', confidence: 0.8, finished: false,
      summary: `Not yet resolved. ${where} has not finished according to OpenLigaDB, so the condition cannot be settled yet.`,
    };
  }
  const final = (match.matchResults ?? []).find((r) => r.resultTypeID === 2)
    ?? [...(match.matchResults ?? [])].sort((a, b) => (b.resultOrderID ?? 0) - (a.resultOrderID ?? 0))[0];
  if (!final) return null;
  const half = (match.matchResults ?? []).find((r) => r.resultTypeID === 1);
  const g1 = final.pointsTeam1;
  const g2 = final.pointsTeam2;
  const winner = g1 > g2 ? home : g2 > g1 ? away : null;
  const score = `${home} ${g1}-${g2} ${away}`;
  const goals = (match.goals ?? []).map((g) => `${g.goalGetterName ?? 'unknown'} ${g.matchMinute ?? '?'}'${g.isPenalty ? ' (pen)' : ''}${g.isOwnGoal ? ' (own goal)' : ''}`);
  const facts = `Full-time result: ${score}${half ? ` (half-time ${half.pointsTeam1}-${half.pointsTeam2})` : ''}. ${winner ? `${winner} won.` : 'The match was a draw.'}${goals.length ? ` Goals: ${goals.join(', ')}.` : ' No goals were scored.'}`;
  let outcome;
  let lead;
  if (condition.kind === 'draw') {
    outcome = winner ? 'no' : 'yes';
    lead = winner ? `No, ${where} was not a draw.` : `Yes, ${where} ended in a draw.`;
  } else if (condition.kind === 'win') {
    const team = condition.team === 1 ? home : away;
    const won = winner === team;
    outcome = won ? 'yes' : 'no';
    lead = won
      ? `Yes, the condition "${team} wins this match outright at full time" was satisfied: ${team} won ${where}.`
      : `No, the condition "${team} wins this match outright at full time" was not satisfied in ${where}.`;
  } else {
    outcome = winner ? 'decided' : 'draw';
    lead = `${where} is finished.`;
  }
  return {
    ...base, outcome, confidence: 0.98, finished: true,
    score_home: g1, score_away: g2, winner, condition: condition.kind,
    summary: `${lead} ${facts} Settled from the OpenLigaDB match record.`,
  };
}
