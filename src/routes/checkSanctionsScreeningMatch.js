// SANCTIONS_SCREENING_MATCH signal endpoint. Given a person or entity name,
// screens it against the US Treasury OFAC SDN list (lib/sanctionsScreening.js)
// and reports whether it matches, and on what program, honestly reporting no
// match rather than a false positive or false certainty.

import { Router } from 'express';
import { screenName, SanctionsUpstreamError, OFAC_ATTRIBUTION } from '../lib/sanctionsScreening.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const PARAM_KEYS = [
  'name', 'entity', 'entity_name', 'person', 'person_name', 'company',
  'company_name', 'query', 'q', 'question', 'text', 'input', 'search',
];

const MAX_INPUT_CHARS = 200;

// Strips question framing ("is X sanctioned", "check X against the OFAC
// list") down to the name itself, the same shallow-strip approach
// entityExtract.js's extractSubject uses for other intents.
const FRAMING_RE = /^\s*(?:is|are|check|screen|does|do|was|were)\b[^]*?\b(?:sanctioned|on\s+the\s+(?:ofac\s+)?(?:sdn\s+)?(?:sanctions\s+)?list|a\s+sanctioned\s+entity|banned|blacklisted|against\s+the\s+ofac\s+(?:sdn\s+)?list)?\s*/i;

function extractName(text) {
  const trimmed = text.replace(/\?+\s*$/, '').trim();
  // Only strip framing when it actually matched a leading interrogative;
  // otherwise a bare name would be untouched anyway since the regex
  // requires the leading keyword.
  const stripped = trimmed.replace(FRAMING_RE, '').replace(/^(?:whether|if)\s+/i, '').trim();
  const cleaned = (stripped || trimmed)
    .replace(/\b(?:is|are|sanctioned|on the (?:ofac )?(?:sdn )?(?:sanctions )?list|a sanctioned entity|banned|blacklisted|against the ofac (?:sdn )?list)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || trimmed;
}

function summarize(name, result) {
  if (!result.matches.length) {
    return `No match for "${name}" was found on the US Treasury OFAC Specially Designated Nationals (SDN) list, screened against ${result.total_records} records. This does not rule out other sanctions or watch lists.`;
  }
  const top = result.matches[0];
  const others = result.matches.slice(1, 3).map((m) => m.name);
  const confidenceWord = top.match_score >= 0.95 ? 'is a match for' : 'closely matches';
  const programText = top.program ? ` under the program ${top.program}` : '';
  return `"${name}" ${confidenceWord} "${top.name}" on the US Treasury OFAC SDN list${programText}${top.title ? `, listed as ${top.title}` : ''}.${others.length ? ` Other possible matches: ${others.join(', ')}.` : ''}`;
}

async function handleSanctionsScreening(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const candidates = PARAM_KEYS.map((k) => params[k]);
  for (const [key, value] of Object.entries(params)) {
    if (!PARAM_KEYS.includes(key)) candidates.push(value);
  }
  const strings = candidates
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().slice(0, MAX_INPUT_CHARS));

  const rawInput = firstUsableValue(...strings);
  if (!rawInput) {
    return respondUnusableInput(
      res,
      'I cannot screen for sanctions because no name was supplied. Pass a person or entity name as the name parameter.',
    );
  }

  const name = extractName(rawInput);
  if (!name || name.length < 2 || /^\d+$/.test(name)) {
    return respondUnusableInput(
      res,
      `${quoteParam(rawInput)} does not name a person or entity to screen. Pass a name such as "John Smith" or a company name.`,
    );
  }

  let result;
  try {
    result = await screenName(name);
  } catch (err) {
    if (err instanceof SanctionsUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: `The OFAC sanctions list is temporarily unavailable, so ${quoteParam(name)} could not be screened. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  const matched = result.matches.length > 0;
  res.json({
    status: 'ok',
    summary: summarize(name, result),
    confidence: matched ? Math.max(0.5, result.matches[0].match_score) : 0.75,
    canonical: ['sanctions-screening', name.toLowerCase().replace(/\s+/g, '-')].join(':'),
    query: name,
    matched,
    matches: result.matches,
    records_screened: result.total_records,
    source: 'OFAC SDN list (treasury.gov)',
    attribution: OFAC_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleSanctionsScreening(req, res));
router.post('/', (req, res) => handleSanctionsScreening(req, res));

export default router;
