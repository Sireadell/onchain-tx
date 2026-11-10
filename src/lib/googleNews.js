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
