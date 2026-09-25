// Looks up CVE (Common Vulnerabilities and Exposures) records. Two free
// sources, tried in an order that depends on whether an NVD key is set:
//
//   CIRCL (cve.circl.lu): the CVE Program's own record for the id (CVE JSON
//     5.x), no key and no practical rate limit. Carries the description,
//     affected products, CWE ids, CISA's Known Exploited Vulnerabilities
//     flag, and a CVSS score for anything published since roughly 2022.
//     Older records have no score here, because NVD assigns those and the
//     CVE Program record does not repeat them.
//   NVD (services.nvd.nist.gov): the National Vulnerability Database.
//     Without a key it allows 5 requests per rolling 30 seconds per IP,
//     and answers 429 or 403 beyond that. Measured 2026-09-16 on the replay
//     harness: a burst of real routed questions turned every answer after
//     the fifth into a 502, which forfeits the question. A free key
//     (https://nvd.nist.gov/developers/request-an-api-key) raises that to
//     50 per 30 seconds and is read from NVD_API_KEY.
//
// So: CIRCL first (NVD first when a key is configured), the other source
// only to fill in a missing score or when the first is down, and every
// answer cached by id so a repeat question never spends a request. A
// rate limit on one source is never a failure while the other can answer.

const NVD_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const CIRCL_URL = 'https://cve.circl.lu/api/cve';
export const CIRCL_ATTRIBUTION = 'CVE data from CIRCL (cve.circl.lu) and the CVE Program, CC BY 4.0.';
export const NVD_ATTRIBUTION = 'This product uses the NVD API but is not endorsed or certified by the NVD.';

const REQUEST_TIMEOUT_MS = Number(process.env.CVE_TIMEOUT_MS) || 8_000;
const CACHE_TTL_MS = Number(process.env.CVE_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
// A "no such record" answer is cached far more briefly: a freshly
// published CVE can appear in either source within minutes.
const NEGATIVE_CACHE_TTL_MS = Number(process.env.CVE_NEGATIVE_CACHE_TTL_MS) || 10 * 60 * 1000;
const KEYWORD_CACHE_TTL_MS = Number(process.env.CVE_KEYWORD_CACHE_TTL_MS) || 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MAX_KEYWORD_CHARS = 200;

const CVE_ID_RE = /^CVE-\d{4}-\d{4,}$/i;
// The id as people actually type it: "CVE-2021-44228", "cve 2021 44228",
// "CVE_2021_44228", or buried in a sentence. Both number groups are
// required, so "CVE 2015" and "CVE-2025" (a year alone) do not match.
const CVE_ID_ANYWHERE_RE = /\bCVE[-_\s]?(\d{4})[-_\s]?(\d{4,7})(?!\d)/i;

// Both sources are unreachable, rate-limited or broken, and nothing is
// cached. This is the only failure the route may report as a 502.
export class CveLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CveLookupError';
  }
}

// One source could not answer right now (429, 403, 5xx, timeout, network).
// Internal: the lookup moves on to the next source and only surfaces a
// CveLookupError once every source has failed this way.
class CveSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CveSourceError';
  }
}

// Same shape as weatherForecast.js's TtlCache, kept local so this module
// has no dependency on the weather code.
class TtlCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      this.store.delete(this.store.keys().next().value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

const recordCache = new TtlCache();
const keywordCache = new TtlCache();

export function __clearCveCacheForTesting() {
  recordCache.store.clear();
  keywordCache.store.clear();
}

export function isCveId(text) {
  return CVE_ID_RE.test(String(text ?? '').trim());
}

// Finds a CVE id anywhere in the text and returns it in canonical form
// ("CVE-2021-44228"), or null when there is none. The engine hands over
// whole questions ("Look up this CVE identifier and report its severity:
// CVE-2021-44228") far more often than a bare id, and the replay harness
// showed every one of those being refused as "no records matched".
export function extractCveId(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(CVE_ID_ANYWHERE_RE);
  if (!match) return null;
  return `CVE-${match[1]}-${match[2]}`;
}

// Every CVE id in the text, canonical and de-duplicated, in the order given.
export function extractCveIds(text) {
  if (typeof text !== 'string') return [];
  const re = new RegExp(CVE_ID_ANYWHERE_RE.source, 'gi');
  const ids = [];
  for (const m of text.matchAll(re)) {
    const id = `CVE-${m[1]}-${m[2]}`.toUpperCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Severity band from a CVSS v3/v4 base score, for records that carry a
// score but no label (NVD's v2 metrics, some CNA-supplied metrics).
export function severityFromScore(score) {
  if (!Number.isFinite(score)) return null;
  if (score === 0) return 'NONE';
  if (score < 4) return 'LOW';
  if (score < 7) return 'MEDIUM';
  if (score < 9) return 'HIGH';
  return 'CRITICAL';
}

async function fetchWithTimeout(url, { headers = {}, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new CveSourceError(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new CveSourceError(`${label} request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- CIRCL (CVE JSON 5.x) ----

// CVSS blocks can sit in the CNA container or in any ADP container (CISA's
// "Vulnrichment" ADP is where most post-2023 scores live). The newest
// version present wins, on the grounds that it is the one the scorers
// themselves consider current.
const CVSS_KEYS = ['cvssV4_0', 'cvssV3_1', 'cvssV3_0', 'cvssV2_0'];

function pickCvss(metricBlocks) {
  for (const key of CVSS_KEYS) {
    for (const block of metricBlocks) {
      const cvss = block?.[key];
      if (cvss && Number.isFinite(cvss.baseScore)) {
        return {
          version: cvss.version ?? key.replace('cvssV', '').replace('_', '.'),
          base_score: cvss.baseScore,
          base_severity: (cvss.baseSeverity ?? severityFromScore(cvss.baseScore))?.toUpperCase() ?? null,
          vector: cvss.vectorString ?? null,
        };
      }
    }
  }
  return null;
}

function summarizeCircl(record, id) {
  const meta = record.cveMetadata ?? {};
  const cna = record.containers?.cna ?? {};
  const adps = record.containers?.adp ?? [];
  const metricBlocks = [...(cna.metrics ?? []), ...adps.flatMap((a) => a.metrics ?? [])];

  const description = cna.descriptions?.find((d) => d.lang === 'en' || d.lang === 'en-US')?.value
    ?? cna.descriptions?.[0]?.value
    ?? null;

  const cwe = [...new Set((cna.problemTypes ?? [])
    .flatMap((p) => p.descriptions ?? [])
    .map((d) => d.cweId)
    .filter(Boolean))];

  // Older records fill vendor and product with the literal "n/a", which
  // would read as a product name in the answer sentence.
  const named = (value) => (value && !/^n\/a$/i.test(String(value).trim()) ? value : null);
  const affected = (cna.affected ?? [])
    .map((a) => ({
      vendor: named(a.vendor),
      product: named(a.product),
      versions: (a.versions ?? []).filter((v) => v.status === 'affected').slice(0, 5).map((v) => {
        if (v.lessThanOrEqual) return `${v.version} through ${v.lessThanOrEqual}`;
        if (v.lessThan) return `${v.version} before ${v.lessThan}`;
        return named(v.version);
      }).filter(Boolean),
    }))
    .filter((a) => a.product)
    .slice(0, 5);

  // CISA's Known Exploited Vulnerabilities flag and SSVC exploitation
  // status, when the CISA ADP has stamped the record.
  let known_exploited = false;
  let exploitation = null;
  for (const block of metricBlocks) {
    if (block?.other?.type === 'kev') known_exploited = true;
    if (block?.other?.type === 'ssvc') {
      const opt = (block.other.content?.options ?? []).find((o) => o.Exploitation);
      if (opt) exploitation = opt.Exploitation;
    }
  }

  const references = [...new Set([...(cna.references ?? []), ...adps.flatMap((a) => a.references ?? [])]
    .map((r) => r.url).filter(Boolean))].slice(0, 5);

  return {
    id: meta.cveId ?? id,
    title: cna.title ?? null,
    description,
    severity: pickCvss(metricBlocks),
    cwe,
    affected,
    known_exploited,
    exploitation,
    published: meta.datePublished ?? null,
    last_modified: meta.dateUpdated ?? null,
    status: meta.state ?? null,
    references,
    source: 'CIRCL',
  };
}

async function fetchCircl(id) {
  const res = await fetchWithTimeout(`${CIRCL_URL}/${encodeURIComponent(id)}`, { label: 'CIRCL' });
  if (res.status === 404) return null;
  if (!res.ok) throw new CveSourceError(`CIRCL returned HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new CveSourceError(`CIRCL returned unreadable JSON: ${err.message}`);
  }
  // An unknown id comes back as an empty object with HTTP 200.
  if (!body || typeof body !== 'object' || (!body.cveMetadata && !body.containers && !body.id)) return null;
  return summarizeCircl(body, id);
}

// ---- NVD (2.0 API) ----

function severityFromNvdMetrics(metrics) {
  if (!metrics) return null;
  const cvss = metrics.cvssMetricV40?.[0] ?? metrics.cvssMetricV31?.[0] ?? metrics.cvssMetricV30?.[0] ?? metrics.cvssMetricV2?.[0];
  if (!cvss) return null;
  const score = cvss.cvssData?.baseScore ?? null;
  return {
    version: cvss.cvssData?.version ?? null,
    base_score: score,
    base_severity: (cvss.cvssData?.baseSeverity ?? cvss.baseSeverity ?? severityFromScore(score))?.toUpperCase() ?? null,
    vector: cvss.cvssData?.vectorString ?? null,
  };
}

function summarizeNvd(item) {
  const cve = item.cve;
  const description = cve.descriptions?.find((d) => d.lang === 'en')?.value
    ?? cve.descriptions?.[0]?.value
    ?? null;
  const cwe = [...new Set((cve.weaknesses ?? [])
    .flatMap((w) => w.description ?? [])
    .map((d) => d.value)
    .filter((v) => /^CWE-\d+$/.test(v ?? '')))];

  return {
    id: cve.id,
    title: null,
    description,
    severity: severityFromNvdMetrics(cve.metrics),
    cwe,
    affected: [],
    known_exploited: Boolean(cve.cisaExploitAdd),
    exploitation: cve.cisaExploitAdd ? 'active' : null,
    published: cve.published ?? null,
    last_modified: cve.lastModified ?? null,
    status: cve.vulnStatus ?? null,
    references: (cve.references ?? []).slice(0, 5).map((r) => r.url),
    source: 'NVD',
  };
}

function nvdHeaders() {
  return process.env.NVD_API_KEY ? { apiKey: process.env.NVD_API_KEY } : {};
}

async function fetchNvd(params, label) {
  const res = await fetchWithTimeout(`${NVD_URL}?${params.toString()}`, { headers: nvdHeaders(), label });
  // NVD answers 404 to a syntactically invalid cveId rather than an empty
  // list, so it reads as "no such record" here, the same as an empty list.
  if (res.status === 404) return [];
  // 429 is the documented rate limit; 403 is what it actually sends once
  // the unkeyed allowance is exhausted (observed 2026-09-16).
  if (!res.ok) throw new CveSourceError(`NVD returned HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new CveSourceError(`NVD returned unreadable JSON: ${err.message}`);
  }
  return (data.vulnerabilities ?? []).map(summarizeNvd);
}

async function fetchNvdById(id) {
  const params = new URLSearchParams({ cveId: id });
  const results = await fetchNvd(params, 'NVD');
  return results[0] ?? null;
}

// Fills the gaps in a primary record from a secondary one: a CIRCL record
// for a 2010 CVE has no score, and NVD's record for a fresh CVE has no
// description while it sits in "Awaiting Analysis". Nothing already
// present is overwritten.
function mergeRecords(primary, secondary) {
  if (!secondary) return primary;
  return {
    ...primary,
    title: primary.title ?? secondary.title,
    description: primary.description ?? secondary.description,
    severity: primary.severity ?? secondary.severity,
    cwe: primary.cwe.length ? primary.cwe : secondary.cwe,
    affected: primary.affected.length ? primary.affected : secondary.affected,
    known_exploited: primary.known_exploited || secondary.known_exploited,
    exploitation: primary.exploitation ?? secondary.exploitation,
    published: primary.published ?? secondary.published,
    last_modified: primary.last_modified ?? secondary.last_modified,
    references: primary.references.length ? primary.references : secondary.references,
    source: `${primary.source}+${secondary.source}`,
  };
}

// Looks up one CVE by id. Returns { record, sources_failed } where record
// is null when neither source knows the id. Throws CveLookupError only
// when every source failed and nothing is cached.
export async function lookupCveById(rawId) {
  const id = extractCveId(String(rawId ?? '')) ?? String(rawId ?? '').trim().toUpperCase();
  if (!isCveId(id)) throw new CveLookupError(`'${rawId}' is not a CVE id`);

  const cached = recordCache.get(id);
  if (cached !== undefined) return { record: cached, sources_failed: [], cached: true };

  const order = process.env.NVD_API_KEY
    ? [['NVD', fetchNvdById], ['CIRCL', fetchCircl]]
    : [['CIRCL', fetchCircl], ['NVD', fetchNvdById]];

  const sourcesFailed = [];
  let record = null;
  for (const [name, fetcher] of order) {
    let found;
    try {
      found = await fetcher(id);
    } catch (err) {
      if (!(err instanceof CveSourceError)) throw err;
      sourcesFailed.push(`${name}: ${err.message}`);
      continue;
    }
    if (!found) continue;
    if (!record) {
      record = found;
      // A record with a score and a description is complete; do not spend
      // a rate-limited call on the second source for nothing.
      if (record.severity && record.description) break;
      continue;
    }
    record = mergeRecords(record, found);
    break;
  }

  if (!record && sourcesFailed.length === order.length) {
    throw new CveLookupError(`every CVE source failed (${sourcesFailed.join('; ')})`);
  }

  // A miss on one source while the other was down is not a confirmed
  // miss, so it is not cached: the next question retries both.
  if (record) {
    recordCache.set(id, record, CACHE_TTL_MS);
  } else if (sourcesFailed.length === 0) {
    recordCache.set(id, null, NEGATIVE_CACHE_TTL_MS);
  }
  return { record, sources_failed: sourcesFailed, cached: false };
}

// Free-text keyword search ("log4j", "openssl heartbleed"). NVD is the
// only one of the two sources with a keyword index, so this shares its
// rate limit; results are cached for an hour to keep repeats free.
export async function searchCveKeyword(keyword) {
  const trimmed = String(keyword ?? '').trim().slice(0, MAX_KEYWORD_CHARS);
  if (!trimmed) throw new CveLookupError('no keyword supplied');

  const cacheKey = trimmed.toLowerCase();
  const cached = keywordCache.get(cacheKey);
  if (cached !== undefined) return { results: cached, cached: true };

  const params = new URLSearchParams({ keywordSearch: trimmed, resultsPerPage: '5' });
  let results;
  try {
    results = await fetchNvd(params, 'NVD keyword search');
  } catch (err) {
    if (err instanceof CveSourceError) throw new CveLookupError(err.message);
    throw err;
  }
  keywordCache.set(cacheKey, results, KEYWORD_CACHE_TTL_MS);
  return { results, cached: false };
}

// Kept for callers that pass either an id or a keyword and want one
// result shape: { results: [...], total }.
export async function lookupCve(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) throw new CveLookupError('no CVE id or keyword supplied');

  const id = extractCveId(trimmed);
  if (id) {
    const { record } = await lookupCveById(id);
    return { results: record ? [record] : [], total: record ? 1 : 0 };
  }
  const { results } = await searchCveKeyword(trimmed);
  return { results, total: results.length };
}
