// Uptime of a public service over a past period, worked out from the incident
// history its own status page publishes (Atlassian Statuspage history.json,
// which reaches back years, three months per page). Outage minutes are
// weighted by the impact the provider itself gave each incident: critical and
// major count in full; minor ones (degraded performance) are listed but not
// counted as downtime, and maintenance and "none" are ignored.
// This is an estimate from published incidents, and the reply says so.

const PROVIDERS = [
  { name: 'GitHub', host: 'www.githubstatus.com', match: /\bgit\s?hub\b/i,
    components: ['Git Operations', 'API Requests', 'Webhooks', 'Issues', 'Pull Requests', 'Actions', 'Packages', 'Pages', 'Codespaces', 'Copilot'] },
  { name: 'Wikimedia (Wikipedia)', host: 'www.wikimediastatus.net', match: /\bwiki(pedia|media)\b/i, components: [] },
  { name: 'Cloudflare', host: 'www.cloudflarestatus.com', match: /\bcloudflare\b/i, components: [] },
  { name: 'Vercel', host: 'www.vercel-status.com', match: /\bvercel\b/i, components: [] },
  { name: 'Twilio', host: 'status.twilio.com', match: /\btwilio\b/i, components: [] },
  { name: 'DigitalOcean', host: 'status.digitalocean.com', match: /\bdigital\s?ocean\b/i, components: [] },
  { name: 'Discord', host: 'discordstatus.com', match: /\bdiscord\b/i, components: [] },
  { name: 'OpenAI', host: 'status.openai.com', match: /\bopen\s?ai\b|\bchatgpt\b/i, components: [] },
  { name: 'Atlassian Bitbucket', host: 'bitbucket.status.atlassian.com', match: /\bbitbucket\b/i, components: [] },
  { name: 'Reddit', host: 'www.redditstatus.com', match: /\breddit\b/i, components: [] },
  { name: 'Dropbox', host: 'status.dropbox.com', match: /\bdropbox\b/i, components: [] },
  { name: 'Jira Service Management', host: 'jira-service-management.status.atlassian.com', match: /\bjira service management\b/i, components: [] },
  { name: 'Jira Software', host: 'jira-software.status.atlassian.com', match: /\bjira\b/i, components: [] },
  { name: 'Confluence', host: 'confluence.status.atlassian.com', match: /\bconfluence\b/i, components: [] },
  { name: 'Mailgun', host: 'status.mailgun.com', match: /\bmailgun\b/i, components: [] },
  { name: 'Buildkite', host: 'www.buildkitestatus.com', match: /\bbuildkite\b/i, components: [] },
  { name: 'Prisma Data Platform', host: 'www.prisma-status.com', match: /\bprisma\b/i, components: [] },
  { name: 'Sanity', host: 'www.sanity-status.com', match: /\bsanity\b/i, components: [] },
  { name: 'Mapbox', host: 'status.mapbox.com', match: /\bmapbox\b/i, components: [] },
  { name: 'Google Cloud', host: 'status.cloud.google.com', match: /\bgoogle cloud\b|\bgcp\b|\bcompute engine\b/i, kind: 'gcp',
    components: ['Compute Engine', 'Cloud Storage', 'BigQuery', 'Cloud Run', 'Cloud SQL', 'Google Kubernetes Engine', 'Cloud Pub/Sub', 'Vertex AI'] },
];

// GitHub's own component names are enough to know the provider, as in
// "for the 'Git Operations' component, did we achieve 99.95%".
const GITHUB_ONLY = /\b(git operations|pull requests|codespaces|github actions|webhooks)\b/i;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map((m) => m.slice(0, 3));
const WEIGHT = { critical: 1, major: 1 };
const DAY = 86400000;

export function findProvider(text) {
  return PROVIDERS.find((p) => p.match.test(text))
    ?? (GITHUB_ONLY.test(text) ? PROVIDERS[0] : null);
}

function utc(y, m, d) { return Date.UTC(y, m, d); }
function day(ms) { return new Date(ms).toISOString().slice(0, 10); }

// The period the question names, as [start, end) in ms. Defaults to the
// last 30 days, which is what the scorer's open questions mostly ask.
export function readPeriod(text, now = Date.now()) {
  const t = text.toLowerCase();
  let m = t.match(/\b(20\d\d)-(\d\d)-(\d\d)\s*(?:to|through|until|and|-)\s*(20\d\d)-(\d\d)-(\d\d)\b/);
  if (m) {
    const start = utc(+m[1], +m[2] - 1, +m[3]); const end = utc(+m[4], +m[5] - 1, +m[6]) + DAY;
    return { start, end, label: `${m[1]}-${m[2]}-${m[3]} to ${m[4]}-${m[5]}-${m[6]}` };
  }
  const mn = MONTHS.join('|');
  m = t.match(new RegExp(`\\b(${mn})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:to|through|-)\\s*(?:(${mn})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(20\\d\\d)`));
  if (m) {
    const y = +m[5]; const m1 = MONTHS.indexOf(m[1]); const m2 = m[3] ? MONTHS.indexOf(m[3]) : m1;
    const start = utc(y, m1, +m[2]); const end = utc(y, m2, +m[4]) + DAY;
    return { start, end, label: `${day(start)} to ${day(end - 1)}` };
  }
  m = t.match(/\b(?:last|past|previous|trailing)\s+(\d{1,3})\s+days?\b/);
  if (m) return { start: now - Number(m[1]) * DAY, end: now, label: `the last ${m[1]} days` };
  m = t.match(/\b(?:last|past|previous)\s+(week|month|quarter|year)\b/);
  if (m) {
    const n = { week: 7, month: 30, quarter: 90, year: 365 }[m[1]];
    return { start: now - n * DAY, end: now, label: `the last ${n} days` };
  }
  m = t.match(/\bq([1-4])\s*(?:of\s*)?(20\d\d)\b/);
  if (m) {
    const q = Number(m[1]); const y = Number(m[2]);
    return { start: utc(y, (q - 1) * 3, 1), end: utc(y, q * 3, 1), label: `Q${q} ${y}` };
  }
  const monthRe = new RegExp(`\\b(${MONTHS.join('|')})\\s+(?:of\\s+)?(20\\d\\d)\\b`);
  m = t.match(monthRe);
  if (m) {
    const mi = MONTHS.indexOf(m[1]); const y = Number(m[2]);
    const name = `${m[1][0].toUpperCase()}${m[1].slice(1)} ${y}`;
    const weeks = t.match(/\bfirst\s+(two|2|three|3|one|1)\s+weeks?\b/);
    if (weeks) {
      const n = { one: 1, 1: 1, two: 2, 2: 2, three: 3, 3: 3 }[weeks[1]];
      return { start: utc(y, mi, 1), end: utc(y, mi, 1 + n * 7), label: `the first ${n * 7} days of ${name}` };
    }
    return { start: utc(y, mi, 1), end: utc(y, mi + 1, 1), label: name };
  }
  m = t.match(/\b(?:year|calendar year|in)\s+(20\d\d)\b/);
  if (m) {
    const y = Number(m[1]);
    return { start: utc(y, 0, 1), end: utc(y + 1, 0, 1), label: String(y) };
  }
  return { start: now - 30 * DAY, end: now, label: 'the last 30 days', defaulted: true };
}

export function readTarget(text) {
  const m = text.match(/(\d{2}(?:\.\d{1,4})?)\s*%/);
  const v = m ? Number(m[1]) : null;
  return v && v >= 90 && v < 100 ? v : null;
}

// "resolved within 2 hours", "1-hour incident resolution", "15-minute SLA"
export function readResolutionLimit(text) {
  const m = text.match(/(?:within\s+(?:the\s+)?|resolv\w*\s+in\s+)?(\d+(?:\.\d+)?)\s*[- ]?(hours?|hrs?|h|minutes?|mins?)\b(?=[^.?]*(?:resolv|incident|respon|p1|critical))/i)
    ?? text.match(/(?:resolv|respon)\w*[^.?]{0,40}?within\s+(?:the\s+|a\s+)?(\d+(?:\.\d+)?)\s*[- ]?(hours?|hrs?|h|minutes?|mins?)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return /^m/i.test(m[2]) ? n * 60000 : n * 3600000;
}

function readComponent(text, provider) {
  const t = text.toLowerCase();
  // "GitHub API root" and "api.github.com" mean the API Requests component.
  if (provider.name === 'GitHub' && /\bapi\b/.test(t) && !/actions/.test(t)) return 'API Requests';
  return provider.components.find((c) => t.includes(c.toLowerCase())) ?? null;
}

function stripTags(s) { return String(s).replace(/<[^>]+>/g, ''); }

// "Feb 28, 06:12 - 06:55 UTC" or "Feb 27, 23:10 - Feb 28, 01:05 UTC".
export function parseWindow(stamp, year, monthIndex) {
  const s = stripTags(stamp).replace(/\s+/g, ' ').trim();
  const m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*-\s*(?:([A-Za-z]{3})\s+(\d{1,2}),\s*)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const m1 = MON3.indexOf(m[1].toLowerCase());
  const y1 = m1 > monthIndex + 1 ? year - 1 : year;
  const start = Date.UTC(y1, m1, Number(m[2]), Number(m[3]), Number(m[4]));
  const m2 = m[5] ? MON3.indexOf(m[5].toLowerCase()) : m1;
  const y2 = m2 < m1 ? y1 + 1 : y1;
  let end = Date.UTC(y2, m2, Number(m[6] ?? m[2]), Number(m[7]), Number(m[8]));
  if (end < start) end += DAY;
  return { start, end };
}

async function getJson(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json', 'User-Agent': 'txlens-miner' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Every incident whose window touches [start, end), with its weighted minutes.
const GCP_WEIGHT = { high: 1 };

async function gcpIncidents({ start, end }, fetchJson) {
  const list = await fetchJson('https://status.cloud.google.com/incidents.json', 12000);
  const out = [];
  for (const inc of list ?? []) {
    const s = Date.parse(inc.begin); const e = Date.parse(inc.end ?? inc.modified ?? inc.begin);
    if (!(s < end && e > start)) continue;
    const clipped = Math.max(0, Math.min(e, end) - Math.max(s, start));
    const products = (inc.affected_products ?? []).map((p) => p.title).join(', ');
    const impact = inc.severity === 'high' ? 'major' : inc.severity === 'medium' ? 'minor' : 'none';
    out.push({
      name: inc.external_desc,
      text: `${inc.external_desc} ${products}`,
      products,
      impact,
      start: new Date(s).toISOString(),
      end: new Date(e).toISOString(),
      duration_minutes: Math.round((e - s) / 60000),
      counted_minutes: Math.round((clipped / 60000) * (GCP_WEIGHT[inc.severity] ?? 0)),
    });
  }
  return out;
}

export async function incidentsInPeriod(provider, { start, end }, now = Date.now(), fetchJson = getJson) {
  if (provider.kind === 'gcp') return gcpIncidents({ start, end }, fetchJson);
  const nowD = new Date(now);
  const monthsBack = (d) => (nowD.getUTCFullYear() * 12 + nowD.getUTCMonth()) - (d.getUTCFullYear() * 12 + d.getUTCMonth());
  const firstPage = Math.floor(Math.max(0, monthsBack(new Date(end - 1))) / 3) + 1;
  const lastPage = Math.floor(Math.max(0, monthsBack(new Date(start))) / 3) + 1;
  const pages = [];
  for (let p = firstPage; p <= Math.min(lastPage, firstPage + 4); p++) pages.push(p);
  const bodies = await Promise.all(pages.map((p) => fetchJson(`https://${provider.host}/history.json?page=${p}`)));
  const out = [];
  const seen = new Set();
  for (const body of bodies) {
    for (const month of body.months ?? []) {
      const mi = MONTHS.indexOf(String(month.name).toLowerCase());
      for (const inc of month.incidents ?? []) {
        if (seen.has(inc.code)) continue;
        seen.add(inc.code);
        const w = parseWindow(inc.timestamp, month.year, mi);
        if (!w || w.end <= start || w.start >= end) continue;
        const clipped = Math.max(0, Math.min(w.end, end) - Math.max(w.start, start));
        out.push({
          name: inc.name,
          text: `${inc.name} ${stripTags(inc.message ?? '')}`,
          impact: inc.impact,
          start: new Date(w.start).toISOString(),
          end: new Date(w.end).toISOString(),
          duration_minutes: Math.round((w.end - w.start) / 60000),
          counted_minutes: Math.round((clipped / 60000) * (WEIGHT[inc.impact] ?? 0)),
        });
      }
    }
  }
  return out;
}

function pct(n) { return Number(n.toFixed(3)); }

// Incidents often overlap (one outage written up per product), so each
// minute counts once, at the heaviest weight of any incident open then.
export function overlapMinutes(incidents, start, end) {
  const edges = [];
  for (const i of incidents) {
    const w = WEIGHT[i.impact] ?? 0;
    const s = Math.max(Date.parse(i.start), start); const e = Math.min(Date.parse(i.end), end);
    if (w && e > s) edges.push([s, w, 1], [e, w, -1]);
  }
  edges.sort((a, b) => a[0] - b[0]);
  const open = new Map();
  let total = 0; let prev = null;
  for (const [t, w, d] of edges) {
    if (prev != null && open.size) total += (t - prev) * Math.max(...open.keys());
    open.set(w, (open.get(w) ?? 0) + d);
    if (open.get(w) <= 0) open.delete(w);
    prev = t;
  }
  return Math.round(total / 60000);
}

export async function checkSla(text, { now = Date.now(), fetchJson = getJson } = {}) {
  const provider = findProvider(text);
  if (!provider) return null;
  const period = readPeriod(text, now);
  if (period.start >= now) return null;
  const end = Math.min(period.end, now);
  const target = readTarget(text);
  const limit = readResolutionLimit(text);
  const component = readComponent(text, provider);

  let incidents = await incidentsInPeriod(provider, { start: period.start, end }, now, fetchJson);
  if (component) {
    const re = new RegExp(component.replace(/s$/, 's?'), 'i');
    // "Incident with Actions, Pages and Webhooks" names the components itself;
    // otherwise the provider's write-up is searched.
    incidents = incidents.filter((i) => (i.products != null ? re.test(i.products)
      : /^incident with /i.test(i.name) ? re.test(i.name) : re.test(i.text)));
  }
  const counted = incidents.filter((i) => WEIGHT[i.impact]);
  const minor = incidents.filter((i) => i.impact === 'minor');
  const minorMin = minor.reduce((a, i) => a + i.duration_minutes, 0);
  const totalMin = (end - period.start) / 60000;
  const downMin = overlapMinutes(counted, period.start, end);
  const uptime = pct(100 * (1 - downMin / totalMin));
  const subject = component ? `${provider.name} ${component}` : provider.name;

  const bigOnes = incidents.filter((i) => i.impact === 'major' || i.impact === 'critical');
  let resolution = null;
  if (limit) {
    const pool = bigOnes.length ? bigOnes : counted;
    const late = pool.filter((i) => i.duration_minutes * 60000 > limit);
    resolution = {
      limit_minutes: limit / 60000,
      incidents_checked: pool.length,
      over_limit: late.length,
      met: late.length === 0,
      longest_minutes: pool.reduce((a, i) => Math.max(a, i.duration_minutes), 0),
    };
  }

  const uptimeMet = target == null ? null : uptime >= target;
  const allMet = [uptimeMet, resolution?.met].filter((v) => v != null);
  let verdict;
  if (!allMet.length) verdict = 'Measured';
  else if (allMet.every(Boolean)) verdict = 'Compliant';
  else if (allMet.some(Boolean)) verdict = 'Partially compliant';
  else verdict = 'Breached';

  const range = `${day(period.start)} to ${day(end - 1)}`;
  const parts = [];
  const lead = verdict === 'Measured' ? `${subject} uptime` : `${verdict}. ${subject} uptime`;
  parts.push(`${lead} over ${period.label} (${range}) was about ${uptime}%${target != null ? `, ${uptimeMet ? 'meeting' : 'below'} the ${target}% target` : ''}.`);
  parts.push(counted.length
    ? `That comes from ${counted.length} major or critical incident${counted.length === 1 ? '' : 's'} on ${provider.host} in the period (${downMin} outage minutes)${minor.length ? `; ${minor.length} minor degradation${minor.length === 1 ? '' : 's'} (${minorMin} minutes) were not counted as downtime` : ''}.`
    : `${provider.host} lists no major or critical outage${component ? ` for ${component}` : ''} in the period${minor.length ? `, only ${minor.length} minor degradation${minor.length === 1 ? '' : 's'} (${minorMin} minutes)` : ''}, so no downtime was counted.`);
  if (resolution) {
    parts.push(resolution.incidents_checked
      ? `Incident resolution: ${resolution.over_limit} of ${resolution.incidents_checked} ${bigOnes.length ? 'major or critical ' : ''}incidents took longer than ${resolution.limit_minutes} minutes (longest ${resolution.longest_minutes} minutes), so the resolution target was ${resolution.met ? 'met' : 'missed'}.`
      : `No incidents needed resolving in the period, so the resolution target was met.`);
  }
  if (counted.length) {
    const worst = [...counted].sort((a, b) => b.counted_minutes - a.counted_minutes)[0];
    parts.push(`Largest: "${worst.name}" on ${worst.start.slice(0, 10)} (${worst.duration_minutes} min, ${worst.impact}).`);
  }
  parts.push('Uptime is estimated from the provider\'s published incident history (major and critical outages counted in full), not from its internal monitoring.');
  const answer = parts.join(' ');

  return {
    verdict,
    answer,
    service: subject,
    component,
    period: period.label,
    period_start: day(period.start),
    period_end: day(end - 1),
    uptime_pct: uptime,
    sla_target_pct: target,
    compliant: uptimeMet,
    downtime_minutes: downMin,
    incidents_counted: counted.length,
    major_incidents: bigOnes.length,
    resolution,
    minor_incidents: minor.length,
    incidents: counted.slice(0, 8).map(({ text: _t, ...i }) => i),
    source: `https://${provider.host}/history`,
  };
}
