// Live news search through the public Google News RSS feed. No key needed.
// It returns real recent articles with publisher, date and link, which is
// what a news question is really asking for. The AI-written summary path in
// webSearch.js stays as the fallback when this feed finds nothing.

const FEED_URL = 'https://news.google.com/rss/search';
const TIMEOUT_MS = 6_000;

// "latest news on SpaceX Starship launch" searches better as "SpaceX Starship
// launch". Only leading and trailing filler is removed, never inner words.
const LEAD_FILLER = /^(?:what(?:'s| is| are)?\s+(?:the\s+)?)?(?:(?:latest|recent|current|newest|breaking)\s+)?(?:news|headlines|developments|updates?|reports?|stories|coverage|findings|advancements|events?)?\s*(?:about|on|regarding|concerning|for|in|of|from)?\s+/i;
const FILLER_WORDS = /\b(?:please|tell me|can you|could you|show me|find)\b/gi;

export function cleanNewsQuery(text) {
  let q = String(text ?? '').replace(/[?!]+\s*$/g, '').replace(FILLER_WORDS, ' ').replace(/\s+/g, ' ').trim();
  const stripped = q.replace(LEAD_FILLER, '').trim();
  if (stripped.split(' ').length >= 1 && stripped.length >= 3) q = stripped;
  return q.slice(0, 200);
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]) : '';
}

export function parseGoogleNewsRss(xml, limit = 5) {
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const out = [];
  for (const [, block] of items) {
    const rawTitle = tag(block, 'title');
    const source = tag(block, 'source');
    // Google appends " - Publisher" to every title.
    const title = source && rawTitle.endsWith(` - ${source}`) ? rawTitle.slice(0, -(source.length + 3)) : rawTitle;
    const published = tag(block, 'pubDate');
    const ms = Date.parse(published);
    if (!title) continue;
    out.push({
      title,
      source: source || null,
      url: tag(block, 'link') || null,
      published_at: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      published_unix: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

const BING_FEED_URL = 'https://www.bing.com/news/search';

// Bing wraps outbound links as bing.com/news/apiclick.aspx?...&url=<real>&...
function unwrapBingLink(link) {
  if (!link) return null;
  try {
    const u = new URL(link);
    const real = u.searchParams.get('url');
    return real || link;
  } catch {
    return link;
  }
}

export function parseBingNewsRss(xml, limit = 5) {
  const items = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const out = [];
  for (const [, block] of items) {
    const title = tag(block, 'title');
    if (!title) continue;
    const ms = Date.parse(tag(block, 'pubDate'));
    out.push({
      title,
      source: tag(block, 'News:Source') || null,
      url: unwrapBingLink(tag(block, 'link')),
      published_at: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
      published_unix: Number.isFinite(ms) ? Math.floor(ms / 1000) : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Second free feed. Never throws, same as the Google one.
export async function searchBingNews(query, { recentDays = 7, limit = 5, fetchImpl = fetch } = {}) {
  const q = cleanNewsQuery(query);
  if (!q) return [];
  const url = `${BING_FEED_URL}?q=${encodeURIComponent(q)}&format=rss`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; txlens-miner/1.0)' } });
    if (!res.ok) return [];
    const cutoff = Date.now() - Math.min(Math.max(Math.floor(Number(recentDays)) || 7, 1), 365) * 86_400_000;
    // Bing has no date operator in the RSS feed, so the window is applied here.
    // Items without a date are kept.
    return parseBingNewsRss(await res.text(), 50)
      .filter((a) => a.published_unix == null || a.published_unix * 1000 >= cutoff)
      .slice(0, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function dedupeKey(a) {
  return String(a.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

// Both feeds, merged and de-duplicated by title, so one feed hiccup never
// empties the list. If both come back empty, retries once with the first five
// words of the topic over a 30 day window.
export async function searchNews(query, { recentDays = 7, limit = 5, fetchImpl = fetch } = {}) {
  const both = async (q, days, n) => {
    const [g, b] = await Promise.all([
      searchGoogleNews(q, { recentDays: days, limit: n, fetchImpl }),
      searchBingNews(q, { recentDays: days, limit: n, fetchImpl }),
    ]);
    const seen = new Set();
    const merged = [];
    // Interleave so both publishers' top stories survive the limit.
    for (let i = 0; i < Math.max(g.length, b.length); i++) {
      for (const a of [g[i], b[i]]) {
        if (!a) continue;
        const key = dedupeKey(a);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(a);
      }
    }
    return merged.slice(0, n);
  };
  let articles = await both(query, recentDays, limit);
  if (!articles.length) {
    const short = cleanNewsQuery(query).split(' ').slice(0, 5).join(' ');
    if (short) articles = await both(short, 30, Math.min(limit, 5));
  }
  return articles;
}

// Returns up to `limit` articles, newest relevant first as Google ranks them.
// Never throws: any failure means "nothing found" and the caller falls back.
export async function searchGoogleNews(query, { recentDays = 7, limit = 5, fetchImpl = fetch } = {}) {
  const q = cleanNewsQuery(query);
  if (!q) return [];
  const days = Math.min(Math.max(Math.floor(Number(recentDays)) || 7, 1), 365);
  const url = `${FEED_URL}?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; txlens-miner/1.0)' } });
    if (!res.ok) return [];
    return parseGoogleNewsRss(await res.text(), limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
