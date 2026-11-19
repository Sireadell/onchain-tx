// Breaking changes between two versions of an npm package, read from the
// project's own release notes (GitHub release for the target version) and,
// when that release only links a migration guide, from the guide's
// "Breaking Changes" section in the repository. Built for questions like
// "We run vitest 1.6.0. Which defaults and APIs changed incompatibly in
// vitest 2.0.0?", where independent model answers disagreed and every one
// of them invented changes that never happened.
//
// Returns null when the question is not an npm upgrade question or the notes
// cannot be found, so the caller falls back to its normal answer path.

const TIMEOUT_MS = 7_000;
const HEADERS = { 'User-Agent': 'TxLens/1.0 (telegraph miner)', Accept: 'application/vnd.github+json' };
const cache = new Map();

async function fetchText(url, fetchImpl, accept) {
  const key = `${accept ?? ''} ${url}`;
  if (cache.has(key)) return cache.get(key);
  const res = await fetchImpl(url, { headers: { ...HEADERS, ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const out = res.ok ? await res.text() : null;
  if (cache.size > 200) cache.clear();
  // Large bodies (a big repository's file tree) are not kept, so the cache
  // stays small.
  if ((res.ok && out.length <= 256_000) || res.status === 404) cache.set(key, out);
  return out;
}
const fetchJson = async (url, fetchImpl) => {
  const t = await fetchText(url, fetchImpl);
  return t ? JSON.parse(t) : null;
};

const UPGRADE_CUES = /\bbreaking\b|\bincompatib|\bmigrat|\bupgrad|\bwhat\s+changed\b|\bchanged\b/i;
const PKG_VERSION_RE = /(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)\s+v?(\d+\.\d+\.\d+)\b/gi;

const cmp = (a, b) => {
  const x = a.split('.').map(Number); const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

export function parseUpgradeQuestion(question) {
  const text = String(question ?? '');
  if (!UPGRADE_CUES.test(text)) return null;
  const byPkg = new Map();
  for (const m of text.matchAll(PKG_VERSION_RE)) {
    const name = m[1].toLowerCase().replace(/\.$/, '');
    if (/^(?:v|version|to|from|on|is|and|the)$/.test(name)) continue;
    if (!byPkg.has(name)) byPkg.set(name, []);
    byPkg.get(name).push(m[2]);
  }
  // The package named with two versions is the one being upgraded; failing
  // that, a single package with one version is the target.
  let best = null;
  for (const [name, versions] of byPkg) {
    const sorted = [...new Set(versions)].sort(cmp);
    const cand = { name, from: sorted.length > 1 ? sorted[0] : null, to: sorted[sorted.length - 1] };
    if (!best || (cand.from && !best.from)) best = cand;
  }
  return best;
}

function repoFromRegistry(meta) {
  const url = typeof meta?.repository === 'string' ? meta.repository : meta?.repository?.url;
  const m = String(url ?? '').match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Lines of a markdown section whose heading mentions "breaking", up to the
// next heading of the same or a higher level.
export function breakingSection(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,4}\s.*\bbreaking\b/i.test(l));
  if (start < 0) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    const h = l.match(/^(#+)\s/);
    if (h && h[1].length <= level) break;
    body.push(l);
  }
  return { level, lines: body };
}

const clean = (s) => String(s)
  .replace(/\s+-\s+by\s+.*$/i, '') // "- by @user in https://..." credit trailer
  .replace(/\[<samp>[^\]]*<\/samp>\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/[*_]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/[.:;,]+$/, '');

// Top-level bullets of a release-notes section, or the sub-headings of a
// migration guide's section when it is written as headings.
export function breakingItems(section) {
  if (!section) return [];
  // Code samples in a migration guide hold "- old line // removed" diffs
  // that are not changes in their own right.
  let fenced = false;
  const prose = section.lines.filter((l) => {
    if (/^\s*(?:```|~~~)/.test(l)) { fenced = !fenced; return false; }
    return !fenced;
  });
  const headings = prose.filter((l) => new RegExp(`^#{${section.level + 1}}\\s`).test(l)).map((l) => clean(l.replace(/^#+\s*/, '')));
  if (headings.length) return headings.filter(Boolean);
  // A bare group label ("- **api:**") carries its changes as indented
  // sub-bullets, which are folded into it.
  const items = [];
  let group = null;
  for (const l of prose) {
    if (/^[-*]\s+\S/.test(l)) {
      const text = clean(l.replace(/^[-*]\s+/, ''));
      group = /:\**\s*$/.test(l) && text.length <= 30 ? { label: text, subs: [] } : null;
      items.push(group ?? text);
    } else if (group && /^\s+[-*]\s+\S/.test(l)) {
      group.subs.push(clean(l.replace(/^\s+[-*]\s+/, '')));
    }
  }
  return items.map((it) => (typeof it === 'string' ? it : `${it.label}: ${it.subs.join(', ')}`)).filter(Boolean);
}

async function releaseFor(owner, repo, name, version, fetchImpl) {
  for (const tag of [`v${version}`, `${name}@${version}`, version]) {
    const rel = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, fetchImpl).catch(() => null);
    if (rel?.body) return rel;
  }
  return null;
}

// A release that only says "read the migration guide here: <url>" is
// followed into the repository's docs by the guide's file name.
async function migrationGuide(owner, repo, body, major, fetchImpl) {
  const link = String(body ?? '').match(/https?:\/\/\S*migrat\S*/i)?.[0]?.replace(/[)\].,]+$/, '');
  if (!link) return null;
  const leaf = new URL(link).pathname.replace(/\.html?$/, '').split('/').filter(Boolean).pop();
  if (!leaf) return null;
  const meta = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, fetchImpl).catch(() => null);
  const branch = meta?.default_branch ?? 'main';
  const tree = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, fetchImpl).catch(() => null);
  // The leaf comes from a link in third-party release text, so it is matched
  // literally, never as a pattern.
  const leafRe = new RegExp(`(?:^|/)${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.mdx?$`, 'i');
  const files = (tree?.tree ?? []).map((t) => t.path).filter((p) => leafRe.test(p));
  // Prefer the React flavour of a multi-framework docs tree, then the shortest path.
  files.sort((a, b) => (b.includes('/react/') - a.includes('/react/')) || a.length - b.length);
  if (!files[0]) return null;
  const md = await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${files[0]}`, fetchImpl, 'text/plain').catch(() => null);
  if (!md) return null;
  return { markdown: md, url: link, path: files[0], major };
}

export async function npmUpgradeAnswer(question, { fetchImpl = fetch } = {}) {
  const parsed = parseUpgradeQuestion(question);
  if (!parsed) return null;
  // The one-version document, not the whole package record: a popular
  // package's full record runs to 16 MB (typescript).
  const meta = await fetchJson(`https://registry.npmjs.org/${parsed.name.replace('/', '%2f')}/${parsed.to}`, fetchImpl).catch(() => null);
  if (meta?.version !== parsed.to) return null;
  const gh = repoFromRegistry(meta);
  if (!gh) return null;

  const rel = await releaseFor(gh.owner, gh.repo, parsed.name, parsed.to, fetchImpl);
  if (!rel) return null;
  let items = breakingItems(breakingSection(rel.body));
  let sourceUrl = rel.html_url;
  let sourceName = `the official ${parsed.name} ${parsed.to} release notes`;
  if (!items.length) {
    const guide = await migrationGuide(gh.owner, gh.repo, rel.body, parsed.to.split('.')[0], fetchImpl);
    items = guide ? breakingItems(breakingSection(guide.markdown)) : [];
    if (items.length) { sourceUrl = guide.url; sourceName = `the official ${parsed.name} v${guide.major} migration guide`; }
  }
  if (!items.length) return null;

  const shown = items.slice(0, 35);
  const range = parsed.from ? `from ${parsed.from} to ${parsed.to}` : `to ${parsed.to}`;
  const list = shown.map((t, i) => `${i + 1}) ${t}`).join('; ');
  const more = items.length > shown.length ? ` (plus ${items.length - shown.length} more in the source)` : '';
  const published = rel.published_at ? `, published ${rel.published_at.slice(0, 10)}` : '';
  return {
    summary: `Upgrading ${parsed.name} ${range} brings ${items.length} breaking ${items.length === 1 ? 'change' : 'changes'} listed in ${sourceName}: ${list}${more}. Source: ${sourceUrl} (${parsed.name} ${parsed.to}${published}).`,
    package: parsed.name,
    from_version: parsed.from,
    to_version: parsed.to,
    breaking_changes: items,
    source: sourceUrl,
    release: rel.html_url,
  };
}
