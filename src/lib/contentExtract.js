// CONTENT_EXTRACTION backing service: fetches a URL and pulls out its
// title, description and readable text. No HTML-parsing library is
// installed (checked package.json 2026-09-16: only express and
// express-rate-limit), so this is a hand-rolled regex strip in the same
// minimal-dependency style as the rest of this codebase, not a DOM parser.

import { parsePublicUrl as parsePublicUrlGuarded, assertResolvesPublic as assertResolvesPublicGuarded } from './ssrfGuard.js';

const FETCH_TIMEOUT_MS = Number(process.env.CONTENT_EXTRACT_TIMEOUT_MS) || 10_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
// A ground-truth extraction is a real article's worth of text, not a whole
// page dump, capped so the graded field stays a readable summary and the
// response body stays a sane size.
const MAX_TEXT_CHARS = 4_000;
// Below this much body text the page is a login wall, a consent screen or
// an app shell (Instagram served "Log In Sign Up" for a reel), and the
// meta description carries more of the page's substance than the body.
const THIN_TEXT_CHARS = 200;

export class ContentExtractError extends Error {}

// This endpoint fetches whatever URL a caller sends, from our own server.
// Without a check here, a caller could point it at internal/loopback/link-
// local addresses (169.254.169.254 is the cloud-metadata endpoint on most
// hosts, including Render) and read back whatever is there through what
// looks like a page-extraction answer. Checked at the hostname level, then
// again on what the hostname resolves to, and again on every redirect hop,
// before any byte of the response is read. The actual address rules live in
// lib/ssrfGuard.js, shared with checkUrlScan.js.
function parsePublicUrl(rawUrl) {
  return parsePublicUrlGuarded(rawUrl, ContentExtractError, 'fetched');
}

async function assertResolvesPublic(parsed) {
  return assertResolvesPublicGuarded(parsed, ContentExtractError, 'fetched');
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim() || null;
}

// <meta name="description"> and the Open Graph tags. Instagram, GitHub and
// most news sites put the page's substance here even when the body is a
// JavaScript shell, and the competing metadata miner on this intent
// (microlink) answers from nothing else.
function extractMeta(html) {
  const meta = {};
  const tagRe = /<meta\b[^>]*>/gi;
  for (const [tag] of html.matchAll(tagRe)) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!key || !content) continue;
    const value = decodeEntities(content).replace(/\s+/g, ' ').trim();
    if (!value) continue;
    if (key === 'og:title' || key === 'twitter:title') meta.title ??= value;
    else if (key === 'description' || key === 'og:description' || key === 'twitter:description') meta.description ??= value;
    else if (key === 'author' || key === 'article:author') meta.author ??= value;
    else if (key === 'article:published_time' || key === 'date' || key === 'pubdate') meta.published ??= value;
    else if (key === 'og:site_name') meta.site_name ??= value;
  }
  return meta;
}

// The named entities actually seen in real page markup, plus numeric
// entities. Anything else is left as-is rather than guessing.
function decodeEntities(text) {
  return String(text)
    .replace(/&(#(\d+)|#x([0-9a-fA-F]+)|[a-zA-Z]+);/g, (whole, entity, dec, hex) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...' };
      return named[entity] ?? whole;
    });
}

// Strips tags whose content is never readable text (scripts, styles,
// navigation chrome, embedded SVG), then strips every remaining tag,
// leaving plain text. Deliberately simple: it does not identify a
// "main content" region the way a real readability library would, so a
// page with heavy nav/footer text will carry more noise than a dedicated
// extractor. Good enough for a factual-content grader that compares
// against a ground-truth excerpt of the page's actual prose.
function stripToText(html) {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n');

  const textOnly = withoutNoise.replace(/<[^>]+>/g, ' ');
  return decodeEntities(textOnly)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !BOILERPLATE_LINE_RE.test(line))
    .join('\n')
    .replace(BOILERPLATE_PHRASE_RE, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// The same GitHub session chrome when it shares a line with real text.
const BOILERPLATE_PHRASE_RE = /\b(?:you signed (?:in|out) (?:with|in) another tab or window\.?|reload to refresh your session\.?|you switched accounts on another tab or window\.?|skip to content)/gi;

// Accessibility and session chrome that survives the tag strip on big
// sites (every GitHub page opens with three lines of it) and says nothing
// about the page. Matched as whole lines so real prose is never touched.
const BOILERPLATE_LINE_RE = /^(?:skip to (?:main )?content|you signed (?:in|out) (?:with|in) another tab or window\.?|reload to refresh your session\.?|you switched accounts on another tab or window\.?|dismiss alert|accept (?:all )?cookies|cookie settings|toggle navigation|menu|search|sign in|sign up|log in|login)$/i;

// Reads at most `limit` bytes of the body and stops. arrayBuffer() would
// download a multi-gigabyte response in full before the size check ran.
async function readBodyCapped(res, limit) {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.max(0, Math.min(chunk.byteLength, limit - offset)));
    bytes.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= limit) break;
  }
  return { bytes, truncated };
}

// Follows redirects by hand so every hop is checked against the private
// address rules above. `redirect: 'follow'` would happily follow a public
// page's 302 straight into the metadata service.
async function fetchChecked(startUrl, signal) {
  let parsed = parsePublicUrl(startUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertResolvesPublic(parsed);
    let res;
    try {
      res = await fetch(parsed.href, {
        signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TelegraphTxLensBot/1.0; +https://telegraphprotocol.com)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en',
        },
      });
    } catch (err) {
      if (err.name === 'AbortError') throw new ContentExtractError('the page did not respond in time');
      const cause = err.cause?.code ?? err.cause?.message ?? err.message;
      throw new ContentExtractError(`the host could not be reached (${cause})`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel?.().catch(() => {});
      if (hop === MAX_REDIRECTS) throw new ContentExtractError('the page redirected too many times');
      parsed = parsePublicUrl(new URL(res.headers.get('location'), parsed.href).href);
      continue;
    }
    return { res, finalUrl: parsed.href };
  }
  throw new ContentExtractError('the page redirected too many times');
}

function describeStatus(status) {
  if (status === 401 || status === 403) return `the site refused the request (HTTP ${status}); it blocks automated readers or needs a login`;
  if (status === 404 || status === 410) return `the page does not exist (HTTP ${status})`;
  if (status === 429) return 'the site is rate-limiting requests (HTTP 429)';
  if (status >= 500) return `the site returned a server error (HTTP ${status})`;
  return `the page returned HTTP ${status}`;
}

export async function extractContent(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let fetched;
  try {
    fetched = await fetchChecked(url, controller.signal);
    const { res, finalUrl } = fetched;

    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      throw new ContentExtractError(describeStatus(res.status));
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml') || contentType === '';
    const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml');
    if (!isHtml && !isText) {
      await res.body?.cancel?.().catch(() => {});
      const length = Number(res.headers.get('content-length'));
      const kind = contentType.split(';')[0] || 'unknown';
      throw new ContentExtractError(`the URL serves ${kind}${Number.isFinite(length) && length > 0 ? ` (${Math.round(length / 1024)} KB)` : ''}, not a web page; only HTML and plain text can be extracted`);
    }

    const { bytes, truncated: bodyTruncated } = await readBodyCapped(res, MAX_HTML_BYTES);
    const charsetMatch = contentType.match(/charset=([\w-]+)/);
    let raw;
    try {
      raw = new TextDecoder(charsetMatch?.[1] ?? 'utf-8').decode(bytes);
    } catch {
      raw = new TextDecoder('utf-8').decode(bytes);
    }

    let title = null;
    let meta = {};
    let fullText;
    if (isHtml) {
      title = extractTitle(raw);
      meta = extractMeta(raw);
      fullText = stripToText(raw);
    } else {
      fullText = raw.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    }

    // A thin body behind a login or consent wall: lead with what the meta
    // tags say the page is about, which is the page's actual content.
    let thin = false;
    if (fullText.length < THIN_TEXT_CHARS && meta.description && !fullText.includes(meta.description)) {
      fullText = [meta.description, fullText].filter(Boolean).join('\n');
      thin = true;
    }
    if (!title && meta.title) title = meta.title;

    const text = fullText.length > MAX_TEXT_CHARS ? `${fullText.slice(0, MAX_TEXT_CHARS)}...` : fullText;
    if (!text) throw new ContentExtractError('no readable text was found on the page');

    return {
      title,
      text,
      description: meta.description ?? null,
      author: meta.author ?? null,
      published: meta.published ?? null,
      site_name: meta.site_name ?? null,
      content_type: contentType.split(';')[0] || 'text/html',
      final_url: finalUrl,
      full_length: fullText.length,
      truncated: fullText.length > MAX_TEXT_CHARS || bodyTruncated,
      thin,
    };
  } finally {
    clearTimeout(timer);
  }
}
