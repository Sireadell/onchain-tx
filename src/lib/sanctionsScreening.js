// SANCTIONS_SCREENING_MATCH signal, name/entity screening against the US
// Treasury OFAC Specially Designated Nationals (SDN) list. Chosen over
// OpenSanctions because OpenSanctions's free tier needs an API key this
// session could not request (no signup access), while the OFAC SDN CSV is
// public, keyless, and is the same official source competing miner
// san-ofac-sdn (live registry, 2026-09-17) is built on.
//
// The list (tens of thousands of rows) is downloaded once and cached in
// memory for CACHE_TTL_MS, so a burst of screening questions costs one
// download rather than one per request. Matching is fuzzy: case and
// punctuation insensitive, tolerant of word order and partial name matches,
// because a caller rarely types a name exactly as OFAC's all-caps CSV does.

const SDN_CSV_URL = 'https://www.treasury.gov/ofac/downloads/sdn.csv';
// Measured live 2026-09-17: this government server's response time for the
// same 5.7 MB file ranged from about 5s to 41s across repeated requests, and
// once even outlasted a 35s client-side abort entirely (the slow leg is the
// download itself, not the CSV parse, confirmed by timing each separately).
// A per-request timeout cannot fix an upstream that is simply sometimes
// slower than Telegraph's own 30s question budget, so this value only
// bounds the worst case for the very first request a fresh process ever
// makes, before any cache exists to fall back on.
const REQUEST_TIMEOUT_MS = Number(process.env.SANCTIONS_TIMEOUT_MS) || 10_000;
const CACHE_TTL_MS = Number(process.env.SANCTIONS_LIST_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;

export const OFAC_ATTRIBUTION = 'Screened against the US Treasury OFAC Specially Designated Nationals (SDN) list, a public US government dataset.';

// OFAC's feed itself could not be fetched: outage, timeout, or a response
// shape that could not be parsed. TxLens's fault, real error code.
export class SanctionsUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SanctionsUpstreamError';
  }
}

let cachedEntries = null;
let cachedAt = 0;
let inflight = null;

export function __resetSanctionsCacheForTesting() {
  cachedEntries = null;
  cachedAt = 0;
  inflight = null;
}

// Lets a test mark the existing cache as stale without waiting out the real
// multi-hour TTL, so the stale-while-revalidate path can be exercised.
export function __setSanctionsCacheAgeForTesting(timestamp) {
  cachedAt = timestamp;
}

function normalizeName(text) {
  return String(text ?? '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// OFAC's SDN CSV has no header row. Columns, in order: ent_num, SDN_Name,
// SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT, Vess_flag,
// Vess_owner, Remarks. Quoted, comma-separated, with embedded commas inside
// quotes (standard CSV) and "-0-" used as a null placeholder.
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function cleanField(value) {
  const v = (value ?? '').trim();
  return v === '-0-' ? '' : v;
}

async function fetchSdnList() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SDN_CSV_URL, { signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    if (err.name === 'AbortError') throw new SanctionsUpstreamError(`OFAC SDN list request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new SanctionsUpstreamError(`OFAC SDN list request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new SanctionsUpstreamError(`OFAC SDN list request returned HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const entries = [];
  for (const line of lines) {
    const fields = parseCsvLine(line);
    if (fields.length < 4) continue;
    const name = cleanField(fields[1]);
    if (!name) continue;
    entries.push({
      ent_num: cleanField(fields[0]),
      name,
      normalized: normalizeName(name),
      type: cleanField(fields[2]),
      program: cleanField(fields[3]),
      title: cleanField(fields[4]),
      remarks: cleanField(fields[11]),
    });
  }
  if (!entries.length) throw new SanctionsUpstreamError('OFAC SDN list returned no parseable rows');
  return entries;
}

function refreshInBackground() {
  if (inflight) return;
  inflight = fetchSdnList()
    .then((entries) => {
      cachedEntries = entries;
      cachedAt = Date.now();
    })
    .catch((err) => {
      // A background refresh failing changes nothing a caller can see: the
      // existing cache (however old) keeps answering, and the next call
      // simply tries again. Logged so a persistently broken feed is
      // visible, never thrown into a request that did not ask for it.
      console.error('sanctions list background refresh failed:', err.message);
    })
    .finally(() => { inflight = null; });
}

// Stale-while-revalidate: once ANY successful download has ever completed,
// a live request is answered from that cache instantly and a refresh (if
// the TTL has lapsed) is kicked off without being awaited. This exists
// because the OFAC feed itself is the slow, unreliable part (measured 5s to
// 41s, occasionally slower than Telegraph's entire 30s question budget),
// so a design that makes a live caller wait on that network call is asking
// to forfeit questions on ordinary bad luck, not a defect in our own code.
// Only the very first call a fresh process ever makes has no cache to fall
// back on and genuinely waits.
export async function getSdnList() {
  if (cachedEntries) {
    if (Date.now() - cachedAt >= CACHE_TTL_MS) refreshInBackground();
    return cachedEntries;
  }
  // No cache yet: this is either the very first call this process has ever
  // made, or a concurrent call arriving while that first one is still in
  // flight. Either way there is nothing to fall back on, so this genuinely
  // waits on (or shares) the one real network attempt.
  if (!inflight) {
    inflight = fetchSdnList()
      .then((entries) => {
        cachedEntries = entries;
        cachedAt = Date.now();
        return entries;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// Called once at server startup (src/index.js) so the cache is warm before
// any real question arrives, the same instinct as the chain-reachability
// probes already run at startup. Errors are swallowed: a failed warm-up
// just means the first real request pays the cold-start cost instead,
// exactly as it would have without this call.
export function prefetchSdnList() {
  getSdnList().catch(() => {});
}

// Token-overlap similarity: fraction of the query's significant words that
// appear as whole words in the candidate name. Cheap, order-independent, and
// tolerant of a middle name, an alias suffix ("aka"), or extra whitespace,
// without pulling in a fuzzy-string-distance dependency for a from-scratch
// build.
function nameSimilarity(queryNormalized, candidateNormalized) {
  const queryWords = queryNormalized.split(' ').filter((w) => w.length > 1);
  if (!queryWords.length) return 0;
  const candidateWords = new Set(candidateNormalized.split(' '));
  if (queryNormalized === candidateNormalized) return 1;
  let hits = 0;
  for (const w of queryWords) {
    if (candidateWords.has(w)) hits += 1;
    else if ([...candidateWords].some((cw) => cw.length >= 4 && w.length >= 4 && (cw.startsWith(w) || w.startsWith(cw)))) hits += 0.6;
  }
  return hits / queryWords.length;
}

const MATCH_THRESHOLD = 0.6;
const MAX_MATCHES = 5;

// Screens `name` against the cached OFAC SDN list. Returns
// { matches: [...], total_records } sorted best-match first. An empty
// `matches` array is a genuine "not found" answer, not an error.
export async function screenName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new SanctionsUpstreamError('no name supplied to screen');
  const entries = await getSdnList();
  const queryNormalized = normalizeName(trimmed);
  const scored = entries
    .map((e) => ({ entry: e, score: nameSimilarity(queryNormalized, e.normalized) }))
    .filter((s) => s.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES);
  return {
    matches: scored.map(({ entry, score }) => ({
      name: entry.name,
      ent_num: entry.ent_num,
      type: entry.type || null,
      program: entry.program || null,
      title: entry.title || null,
      remarks: entry.remarks || null,
      match_score: Number(score.toFixed(2)),
    })),
    total_records: entries.length,
  };
}
