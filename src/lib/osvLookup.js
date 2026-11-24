// Free OSV (osv.dev) and FIRST EPSS lookups for VULNERABILITY_TRIAGE.
// Both need no key. Every call has a 5 second cap and returns null on any
// failure, so the caller can fall back to its older behaviour.

const OSV_BASE = 'https://api.osv.dev/v1';
const EPSS_URL = 'https://api.first.org/data/v1/epss';
const TIMEOUT_MS = 5000;

async function getJson(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const GHSA_RE = /\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/gi;

export function extractGhsaIds(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(GHSA_RE)) {
    const id = `GHSA-${m[0].slice(5).toLowerCase()}`;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export async function fetchOsvVuln(id) {
  const body = await getJson(`${OSV_BASE}/vulns/${encodeURIComponent(id)}`);
  return body?.id ? body : null;
}

export async function queryOsvPackage({ purl, name, ecosystem, version }) {
  const pkg = purl ? { purl } : { name, ecosystem };
  const payload = purl ? { package: pkg } : { package: pkg, version };
  const body = await getJson(`${OSV_BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return body && typeof body === 'object' ? (body.vulns ?? []) : null;
}

// Returns a Map of CVE id (upper case) to EPSS number, or null when the
// service did not answer. Ids with no record are simply absent from the map.
export async function fetchEpss(cveIds) {
  if (!cveIds.length) return new Map();
  const body = await getJson(`${EPSS_URL}?cve=${cveIds.map(encodeURIComponent).join(',')}`);
  if (!body || !Array.isArray(body.data)) return null;
  const map = new Map();
  for (const row of body.data) {
    const n = Number(row.epss);
    if (row.cve && Number.isFinite(n)) map.set(String(row.cve).toUpperCase(), n);
  }
  return map;
}

function parts(v) {
  const clean = String(v).trim().replace(/^v/i, '').split(/[+]/)[0];
  const [main, pre] = clean.split(/-(.+)/);
  return { nums: main.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : 0)), pre: pre ?? null };
}

export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  const len = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < len; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  if (x.pre && y.pre) return x.pre < y.pre ? -1 : x.pre > y.pre ? 1 : 0;
  return 0;
}

function inRange(version, range) {
  if (!range || !Array.isArray(range.events) || range.type === 'GIT') return false;
  let vulnerable = false;
  for (const ev of range.events) {
    if (ev.introduced !== undefined) {
      if (ev.introduced === '0' || compareVersions(version, ev.introduced) >= 0) vulnerable = true;
    } else if (ev.fixed !== undefined) {
      if (compareVersions(version, ev.fixed) >= 0) vulnerable = false;
    } else if (ev.last_affected !== undefined) {
      if (compareVersions(version, ev.last_affected) > 0) vulnerable = false;
    }
  }
  return vulnerable;
}

// Entries of vuln.affected for the package the question names (matched by
// name appearing in the question), or all entries when none is named.
export function pickAffected(vuln, question) {
  const all = (vuln.affected ?? []).filter((a) => a.package?.name);
  const q = String(question ?? '').toLowerCase();
  const named = all.filter((a) => q.includes(a.package.name.toLowerCase()));
  return named.length ? named : all;
}

export function fixedVersions(entries) {
  const out = [];
  for (const a of entries) {
    for (const r of a.ranges ?? []) {
      for (const ev of r.events ?? []) if (ev.fixed && !out.includes(ev.fixed)) out.push(ev.fixed);
    }
  }
  return out;
}

export function isVersionAffected(entries, version) {
  for (const a of entries) {
    if ((a.versions ?? []).some((v) => compareVersions(v, version) === 0 && String(v).replace(/^v/i, '') === String(version).replace(/^v/i, ''))) return true;
    if ((a.ranges ?? []).some((r) => inRange(version, r))) return true;
  }
  return false;
}

export function osvSeverity(vuln) {
  return vuln.database_specific?.severity ?? null;
}
export function osvCves(vuln) {
  return (vuln.aliases ?? []).filter((a) => /^CVE-/i.test(a));
}
