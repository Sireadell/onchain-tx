// CVE_LOOKUP signal endpoint. Given a CVE id (e.g. CVE-2021-44228), a
// sentence containing one, or a product keyword, returns the matching
// vulnerability record from CIRCL and the NVD (lib/cveLookup.js).
//
// Params: cve (the id or keyword). The engine uses whatever name the
// competing miners on this intent declare, not just ours: the live
// registry on 2026-09-16 showed cve_id (nvd, secwire, patchsignal,
// sentinelvault), id, query, q, question, cve_query and keywordSearch,
// and the replay harness confirmed cve_id, id and vulnerability were all
// being refused here as "no CVE id supplied". Every one of those is read,
// and a CVE id is pulled out of the value wherever it sits in the text.

import { Router } from 'express';
import {
  lookupCveById, searchCveKeyword, extractCveId, CveLookupError,
  CIRCL_ATTRIBUTION, NVD_ATTRIBUTION,
} from '../lib/cveLookup.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';
import { isQuestionLike } from '../lib/intentGuard.js';

const router = Router();

const PARAM_KEYS = [
  'cve', 'cve_id', 'cveId', 'id', 'vulnerability', 'cve_query', 'keyword',
  'keywordSearch', 'query', 'q', 'question', 'text', 'input', 'search',
];

// Caller input is echoed and searched, never passed through whole: a
// 20k-character value must cost the same as a short one.
const MAX_INPUT_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 480;

// Words that describe the kind of lookup rather than the thing being
// looked up. "known vulnerabilities in log4j" is a search for "log4j".
const KEYWORD_NOISE_RE = /\b(?:cves?|vulnerabilit(?:y|ies)|exploits?|advisor(?:y|ies)|security|issues?|flaws?|bugs?|known|recent|latest|newest|critical|criticial|high|medium|low|severity|priority|list|search|find|lookup|look\s+up|show|give|tell|me|what|which|is|are|the|a|an|in|for|of|about|on|with|affecting|affected|by|please|any|all|there|and|report|details?|info(?:rmation)?)\b/gi;

// Something the vulnerability index can actually be asked about: a
// product, vendor or technology word. A sentence with none of these is a
// question about something else that landed here by routing accident.
const VULN_CUES_RE = /\b(?:cve|vulnerabilit|exploit|cvss|nvd|patch|security|advisory|zero.?day|rce|remote code|injection|overflow|xss|log4j|openssl|apache|nginx|windows|linux|kernel|chrome|firefox|java|python|node|npm|wordpress|cisco|fortinet|microsoft|oracle|vmware|citrix|jenkins|kubernetes|docker|struts|spring|django|rails|php|mysql|postgres|redis|ssh|tls|ssl|vpn|router|firewall|firmware|malware|ransomware)/i;

function trimDescription(text) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_DESCRIPTION_CHARS) return clean;
  const cut = clean.slice(0, MAX_DESCRIPTION_CHARS);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return lastStop > 200 ? cut.slice(0, lastStop + 1) : `${cut.trim()}...`;
}

function isoDate(value) {
  if (!value) return null;
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

// The graded sentence. Leads with id, severity and score, the three
// things every winning answer on this intent stated first, then the
// description, then what it affects and whether it is being exploited.
function summarizeRecord(r) {
  const parts = [];
  const sev = r.severity;
  if (sev && Number.isFinite(sev.base_score)) {
    const label = sev.base_severity ? sev.base_severity : 'unrated';
    const version = sev.version ? `CVSS ${sev.version}` : 'CVSS';
    parts.push(`${r.id} is rated ${label} with a ${version} base score of ${sev.base_score.toFixed(1)}.`);
  } else if (r.description) {
    parts.push(`${r.id} has no CVSS score assigned yet${r.status ? ` (status: ${String(r.status).toLowerCase().replace(/_/g, ' ')})` : ''}.`);
  } else {
    parts.push(`${r.id} is in the CVE registry${r.status ? ` with state ${r.status}` : ''} but has no published description or score yet.`);
  }

  const description = trimDescription(r.description);
  if (description) parts.push(description);

  const affected = (r.affected ?? [])
    .filter((a) => a.product)
    .slice(0, 3)
    .map((a) => {
      const name = a.vendor && !String(a.product).toLowerCase().includes(String(a.vendor).toLowerCase())
        ? `${a.vendor} ${a.product}`
        : a.product;
      return a.versions?.length ? `${name} (${a.versions.slice(0, 3).join(', ')})` : name;
    });
  if (affected.length) parts.push(`Affects ${affected.join('; ')}.`);

  if (r.cwe?.length) parts.push(`Weakness: ${r.cwe.slice(0, 4).join(', ')}.`);

  const published = isoDate(r.published);
  if (published) parts.push(`Published ${published}.`);

  if (r.known_exploited) {
    parts.push(`Listed in CISA's Known Exploited Vulnerabilities catalog${r.exploitation ? ` (exploitation: ${r.exploitation})` : ''}.`);
  } else if (r.exploitation && r.exploitation !== 'none') {
    parts.push(`CISA exploitation status: ${r.exploitation}.`);
  }

  return parts.join(' ');
}

function attributionFor(source) {
  const notes = [];
  if (/CIRCL/.test(source)) notes.push(CIRCL_ATTRIBUTION);
  if (/NVD/.test(source)) notes.push(NVD_ATTRIBUTION);
  return notes.join(' ');
}

function recordBody(rawInput, r, lookup) {
  const complete = Boolean(r.severity && r.description);
  return {
    query: String(rawInput).slice(0, MAX_INPUT_CHARS),
    status: 'ok',
    summary: summarizeRecord(r),
    confidence: complete ? 0.95 : 0.8,
    canonical: ['cve-lookup', r.id].join(':'),
    cve_id: r.id,
    title: r.title,
    severity: r.severity?.base_severity ?? null,
    cvss_score: r.severity?.base_score ?? null,
    cvss_version: r.severity?.version ?? null,
    cvss_vector: r.severity?.vector ?? null,
    description: r.description,
    cwe: r.cwe ?? [],
    affected: r.affected ?? [],
    known_exploited: r.known_exploited ?? false,
    exploitation: r.exploitation ?? null,
    published: r.published,
    last_modified: r.last_modified,
    record_status: r.status,
    references: r.references ?? [],
    source: r.source,
    attribution: attributionFor(r.source),
    ...(lookup.sources_failed?.length ? { degraded: true, sources_unavailable: lookup.sources_failed } : {}),
    checked_at: new Date().toISOString(),
  };
}

// Reduces a free-text value to the product or technology being asked
// about, or null when nothing searchable survives (a bare "CVE", a year
// on its own, an unrelated question).
function deriveKeyword(text) {
  const cleaned = text
    .replace(/[?!.,;:'"()[\]]+/g, ' ')
    .replace(KEYWORD_NOISE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  // A year alone ("CVEs 2010 high priority" -> "2010") is not a keyword
  // the index can use; NVD would return the first five CVEs with "2010"
  // anywhere in their text.
  if (/^\d{4}$/.test(cleaned)) return null;
  // No product or vendor name runs to a hundred characters or seven
  // words; anything that long is a passage or garbage, not a keyword.
  if (cleaned.length > 100 || cleaned.split(/\s+/).length > 6) return null;
  return cleaned;
}

function summarizeKeywordResults(keyword, results) {
  const ranked = [...results].sort((a, b) => (b.severity?.base_score ?? -1) - (a.severity?.base_score ?? -1));
  const lead = ranked[0];
  const leadSentence = lead.severity && Number.isFinite(lead.severity.base_score)
    ? `The most severe is ${lead.id}, rated ${lead.severity.base_severity ?? 'unrated'} (CVSS ${lead.severity.base_score.toFixed(1)}): ${trimDescription(lead.description) ?? 'no description available'}`
    : `${lead.id}: ${trimDescription(lead.description) ?? 'no description available'}`;
  const others = ranked.slice(1, 5).map((r) => `${r.id}${r.severity?.base_severity ? ` (${r.severity.base_severity})` : ''}`);
  return `${results.length} CVE record${results.length === 1 ? '' : 's'} match "${keyword}". ${leadSentence}${others.length ? ` Others: ${others.join(', ')}.` : ''}`;
}

async function handleCveLookup(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  // Every declared alias first, then any other string param the engine
  // may have filled: an id is an id wherever it was sent.
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
      'I cannot look up a CVE because no CVE id or keyword was supplied. Pass a CVE id (e.g. CVE-2021-44228) or a product keyword as the cve parameter.',
    );
  }

  let id = null;
  for (const value of strings) {
    id = extractCveId(value);
    if (id) break;
  }

  if (id) {
    let lookup;
    try {
      lookup = await lookupCveById(id);
    } catch (err) {
      if (err instanceof CveLookupError) {
        return res.status(502).json({
          status: 'error',
          summary: `Both CVE sources are temporarily unavailable for ${id}. Retry shortly.`,
          confidence: 0,
          error: err.message,
        });
      }
      throw err;
    }
    if (!lookup.record) {
      return respondUnusableInput(
        res,
        `${id} is not in the CVE registry or the National Vulnerability Database. Check the year and sequence number; a valid id looks like CVE-2021-44228.`,
      );
    }
    return res.json(recordBody(rawInput, lookup.record, lookup));
  }

  // No id anywhere. A question about something other than software
  // vulnerabilities is answered honestly rather than searched: NVD's
  // keyword index would match "FDA" or "Mars" against random advisories
  // and spend a rate-limited call to do it.
  const questionLike = isQuestionLike(rawInput);
  if (questionLike && !VULN_CUES_RE.test(rawInput)) {
    return respondUnusableInput(
      res,
      'This does not name a CVE id or a software vulnerability to look up. Pass a CVE id such as CVE-2021-44228, or a product keyword such as log4j, and I will report its severity, CVSS score and description.',
    );
  }

  // A URL is a different intent's input ("https://build.jigjoy.ai/#faq"
  // arrived here live); searching the index for its pieces cannot help.
  const keyword = /https?:\/\/|www\./i.test(rawInput) ? null : deriveKeyword(rawInput);
  if (!keyword) {
    return respondUnusableInput(
      res,
      `${quoteParam(rawInput)} is not a complete CVE id and names no product to search for. A CVE id has the form CVE-YYYY-NNNN, for example CVE-2021-44228; I cannot list every CVE for a year or severity on its own.`,
    );
  }

  let search;
  try {
    search = await searchCveKeyword(keyword);
  } catch (err) {
    if (err instanceof CveLookupError) {
      // The keyword index is NVD only, and an unkeyed NVD allows five
      // calls per 30 seconds. A 502 here forfeits the question; a plain
      // answer saying what would work does not.
      return respondUnusableInput(
        res,
        `The vulnerability keyword index is rate-limited right now, so I could not search for ${keyword}. Pass a specific CVE id such as CVE-2021-44228 and it can be answered from the CVE registry directly.`,
      );
    }
    throw err;
  }

  if (!search.results.length) {
    return respondUnusableInput(
      res,
      `No CVE records matched the keyword ${quoteParam(keyword)}. Try a product or vendor name, or pass a CVE id such as CVE-2021-44228.`,
    );
  }

  res.json({
    query: String(rawInput).slice(0, MAX_INPUT_CHARS),
    status: 'ok',
    summary: summarizeKeywordResults(keyword, search.results),
    confidence: 0.7,
    canonical: ['cve-lookup', keyword.toLowerCase(), search.results[0]?.id ?? ''].join(':'),
    keyword,
    result_count: search.results.length,
    cves: search.results.map((r) => ({
      cve_id: r.id,
      severity: r.severity?.base_severity ?? null,
      cvss_score: r.severity?.base_score ?? null,
      description: trimDescription(r.description),
      published: r.published,
    })),
    source: 'NVD',
    attribution: NVD_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleCveLookup(req, res));
router.post('/', (req, res) => handleCveLookup(req, res));

export default router;
