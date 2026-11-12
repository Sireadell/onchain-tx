// Data-backed endpoints for the intents that can be answered from a free,
// keyless public source: air quality (Open-Meteo), yield rates and stablecoin
// supply (DefiLlama), DEX liquidity (DexScreener), live URL health, post
// search (web search restricted to x.com) and text embeddings (computed here).

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { searchWeb, hasWebSearchProvider } from '../lib/webSearch.js';
import { parsePublicUrl, assertResolvesPublic } from '../lib/ssrfGuard.js';

const params = (req) => (req.method === 'GET' ? req.query : req.body) ?? {};
const get = (p, keys) => firstUsableValue(...keys.map((k) => p?.[k]));
const now = () => new Date().toISOString();

async function getJson(url, ms = 12_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'txlens-miner/1.0' } });
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${r.status}`);
  return r.json();
}

function both(router, fn) {
  router.get('/', fn);
  router.post('/', fn);
  return router;
}

// A 200 with the fields named, never a 5xx: a 5xx is booked as no answer.
function fail(res, intent, err) {
  return res.json({
    status: 'unavailable',
    verdict: 'unavailable',
    summary: `The live source for ${intent.toLowerCase().replace(/_/g, ' ')} did not answer at request time, so no figure is stated rather than one guessed.`,
    confidence: 0.2,
    error: String(err?.message || err),
    checked_at: now(),
  });
}

function stripLead(text) {
  return String(text).replace(/^\s*(?:what(?:'s| is| are)|how(?:'s| is)|check|tell me|give me|show)?\s*(?:the\s+)?(?:current\s+|live\s+)?(?:air\s+quality(?:\s+index)?|aqi|yield|apy)?\s*(?:in|for|of|at|on)?\s*/i, '').replace(/[?.!]+$/, '').trim();
}

/* ---------- AIR_QUALITY_INDEX ---------- */
function aqiBand(v) {
  if (v <= 50) return 'Good';
  if (v <= 100) return 'Moderate';
  if (v <= 150) return 'Unhealthy for sensitive groups';
  if (v <= 200) return 'Unhealthy';
  if (v <= 300) return 'Very unhealthy';
  return 'Hazardous';
}
// WHO 2021 guideline values for the 24 hour mean, used to put a reading in
// context: PM2.5 15 ug/m3, PM10 45 ug/m3, NO2 25 ug/m3.
export function whoContext(pm25, pm10, no2) {
  const parts = [];
  const line = (name, value, limit) => {
    if (!Number.isFinite(value) || value <= 0) return;
    const ratio = value / limit;
    parts.push(`${name} at ${value} ug/m3 is ${ratio <= 1 ? 'within' : `${ratio.toFixed(1)} times`} the WHO 24-hour guideline of ${limit} ug/m3`);
  };
  line('PM2.5', pm25, 15);
  line('PM10', pm10, 45);
  line('NO2', no2, 25);
  return parts.length ? `${parts.join('; ')}.` : '';
}
const AQI_ADVICE = {
  Good: 'Air quality is satisfactory and poses little or no risk.',
  Moderate: 'Acceptable for most people; unusually sensitive people should consider limiting long or heavy outdoor exertion.',
  'Unhealthy for sensitive groups': 'People with heart or lung disease, older adults and children should reduce long or heavy outdoor exertion.',
  Unhealthy: 'Everyone should reduce long or heavy outdoor exertion; sensitive groups should avoid it.',
  'Very unhealthy': 'Everyone should avoid long or heavy outdoor exertion.',
  Hazardous: 'Everyone should avoid all outdoor physical activity.',
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// A past day named in the question ("on October 26, 2023", "2024-07-25",
// "yesterday"). Scored questions ask about past days and were answered with
// the current reading.
export function pastDateFromText(text, today = new Date()) {
  const t = String(text ?? '');
  let m = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  let date = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  if (!date) {
    m = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'i').exec(t);
    if (m) date = `${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  if (!date && /\byesterday\b/i.test(t)) date = new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (!date) return null;
  return date < today.toISOString().slice(0, 10) ? date : null;
}

function placeCandidates(raw) {
  const base = stripLead(raw) || String(raw);
  const cleaned = base
    .replace(/\b(?:downtown|central|greater|metro(?:politan)?|the|area|region|city of|near .*$|around .*$)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
  const out = [base, cleaned];
  // "Los Angeles, California" -> "Los Angeles"
  if (base.includes(',')) out.push(base.split(',')[0].trim());

  return [...new Set(out.filter((x) => x && x.length >= 2))];
}

const mean = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};

export const airQualityRouter = both(Router(), async (req, res) => {
  const p = params(req);
  const raw = get(p, ['city', 'location', 'place', 'query', 'q', 'question']);
  if (!raw) return respondUnusableInput(res, 'I cannot report air quality because no place was supplied. Pass a city as the city or query parameter.');
  const question = get(p, ['query', 'q', 'question']) ?? '';
  const pastDate = pastDateFromText(`${question} ${get(p, ['date', 'day']) ?? ''}`);
  try {
    let hit = null;
    let place = null;
    for (const candidate of placeCandidates(raw)) {
      const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(candidate)}&count=1&language=en&format=json`);
      hit = g?.results?.[0];
      place = candidate;
      if (hit) break;
    }
    if (!hit) return respondUnusableInput(res, `I could not find a place called ${quoteParam(place)}. Try a city name.`);
    if (pastDate) {
      const where = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
      const h = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${hit.latitude}&longitude=${hit.longitude}&hourly=pm2_5,pm10,us_aqi,ozone,nitrogen_dioxide&start_date=${pastDate}&end_date=${pastDate}`);
      const hourly = h?.hourly ?? {};
      const pm25 = mean(hourly.pm2_5 ?? []);
      const pm10 = mean(hourly.pm10 ?? []);
      const aqis = (hourly.us_aqi ?? []).filter(Number.isFinite);
      if (pm25 == null && !aqis.length) {
        return res.json({ status: 'not_found', verdict: 'not_found', found: false, date: pastDate, location: where, pm2_5: null, pm10: null, us_aqi: null, summary: `No modelled air quality values are available for ${where} on ${pastDate}; the Open-Meteo archive (CAMS) starts in mid-2022.`, confidence: 0.6, source: 'Open-Meteo air quality archive', checked_at: now() });
      }
      const peak = aqis.length ? Math.max(...aqis) : null;
      const band = peak != null ? aqiBand(peak) : null;
      const summary = `On ${pastDate} in ${where}, PM2.5 averaged ${pm25} ug/m3 over the day and PM10 ${pm10} ug/m3, with the US AQI peaking at ${peak} (${band}). `
        + `These are Open-Meteo's modelled hourly values (CAMS) for the city's coordinates (${hit.latitude}, ${hit.longitude}), not one monitoring station's measurement.`;
      return res.json({
        status: 'ok', verdict: 'found', found: true, summary, date: pastDate, location: where,
        latitude: hit.latitude, longitude: hit.longitude, pm2_5: pm25, pm10, us_aqi: peak, category: band,
        ozone_mean: mean(hourly.ozone ?? []), no2_mean: mean(hourly.nitrogen_dioxide ?? []), hours: aqis.length,
        method: 'Open-Meteo air-quality model (CAMS), hourly values for the day', source: 'Open-Meteo air quality archive',
        confidence: 0.8, canonical: ['air-quality', hit.name.toLowerCase(), pastDate].join(':'), checked_at: now(),
      });
    }
    const a = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${hit.latitude}&longitude=${hit.longitude}&current=us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide`);
    const c = a?.current;
    if (!c || c.us_aqi == null) return respondUnusableInput(res, `No air quality reading is available for ${hit.name} right now.`);
    const band = aqiBand(c.us_aqi);
    const where = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
    const summary = `Air quality in ${where} is ${band}: US AQI ${c.us_aqi} (European AQI ${c.european_aqi}), PM2.5 ${c.pm2_5} ug/m3, PM10 ${c.pm10} ug/m3, ozone ${c.ozone} ug/m3, NO2 ${c.nitrogen_dioxide} ug/m3, as of ${c.time} UTC. ${AQI_ADVICE[band] ?? ''} ${whoContext(c.pm2_5, c.pm10, c.nitrogen_dioxide)} Modelled values (Open-Meteo, CAMS) for the city's coordinates (${hit.latitude}, ${hit.longitude}), not one monitoring station.`.replace(/\s+/g, ' ').trim();
    res.json({ status: 'ok', verdict: 'found', found: true, summary, answer: summary, us_aqi: c.us_aqi, ozone: c.ozone, nitrogen_dioxide: c.nitrogen_dioxide, observed_at: c.time, latitude: hit.latitude, longitude: hit.longitude, european_aqi: c.european_aqi, category: band, pm2_5: c.pm2_5, pm10: c.pm10, location: where, source: 'Open-Meteo air quality', confidence: 0.9, canonical: ['air-quality', hit.name.toLowerCase()].join(':'), checked_at: now() });
  } catch (e) { fail(res, 'AIR_QUALITY_INDEX', e); }
});

/* ---------- CRYPTO_YIELD_RATE ---------- */
let poolsCache = { at: 0, data: null };
async function pools() {
  if (poolsCache.data && Date.now() - poolsCache.at < 10 * 60_000) return poolsCache.data;
  const j = await getJson('https://yields.llama.fi/pools', 30_000);
  poolsCache = { at: Date.now(), data: j.data };
  return j.data;
}
export const yieldRouter = both(Router(), async (req, res) => {
  const p = params(req);
  const raw = get(p, ['asset', 'token', 'symbol', 'protocol', 'pool', 'query', 'q', 'question']);
  if (!raw) return respondUnusableInput(res, 'I cannot report a yield because no asset or protocol was supplied. Pass it as the asset or query parameter.');
  const text = String(raw).toLowerCase();
  const chainWant = get(p, ['chain']);
  try {
    const all = await pools();
    const words = text.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !['the', 'what', 'is', 'apy', 'apr', 'yield', 'rate', 'on', 'for', 'of', 'current', 'best', 'staking', 'lending', 'in'].includes(w));
    let best = all.filter((x) => x.tvlUsd > 1_000_000 && words.length && words.some((w) => x.symbol?.toLowerCase().split(/[-/ ]/).includes(w) || x.project?.toLowerCase() === w));
    const chain = chainWant ? String(chainWant).toLowerCase() : words.find((w) => all.some((x) => x.chain?.toLowerCase() === w));
    if (chain) best = best.filter((x) => x.chain?.toLowerCase() === chain);
    best.sort((a, b) => b.tvlUsd - a.tvlUsd);
    const top = best.slice(0, 3);
    if (!top.length) return respondUnusableInput(res, `No yield pool with at least 1M USD of liquidity matched ${quoteParam(raw)}. Try a token symbol such as USDC or ETH, or a protocol such as aave-v3.`);
    const lines = top.map((x) => `${x.symbol} on ${x.project} (${x.chain}): ${Number(x.apy).toFixed(2)}% APY (base ${Number(x.apyBase ?? 0).toFixed(2)}%, reward ${Number(x.apyReward ?? 0).toFixed(2)}%), TVL $${Math.round(x.tvlUsd).toLocaleString('en-US')}`);
    const summary = `Largest matching yield pools right now: ${lines.join('; ')}. Source: DefiLlama yields.`;
    res.json({ status: 'ok', summary, answer: summary, top_apy_percent: top[0].apy, pools: top.map((x) => ({ pool: x.pool, symbol: x.symbol, project: x.project, chain: x.chain, apy: x.apy, tvl_usd: x.tvlUsd })), source: 'DefiLlama yields', confidence: 0.85, canonical: ['crypto-yield-rate', words.join('-')].join(':'), checked_at: now() });
  } catch (e) { fail(res, 'CRYPTO_YIELD_RATE', e); }
});

/* ---------- ASSET_RESERVE_ATTESTATION ---------- */
export const reserveRouter = both(Router(), async (req, res) => {
  const p = params(req);
  const raw = get(p, ['asset', 'token', 'stablecoin', 'symbol', 'issuer', 'query', 'q', 'question']);
  if (!raw) return respondUnusableInput(res, 'I cannot attest reserves because no asset was supplied. Pass a stablecoin such as USDC as the asset or query parameter.');
  const text = String(raw).toLowerCase();
  try {
    const j = await getJson('https://stablecoins.llama.fi/stablecoins?includePrices=true', 30_000);
    const coin = (j.peggedAssets || []).find((c) => text.split(/[^a-z0-9]+/).includes(c.symbol.toLowerCase()) || text.includes(c.name.toLowerCase()));
    if (!coin) return respondUnusableInput(res, `No tracked stablecoin matched ${quoteParam(raw)}. Try a symbol such as USDT, USDC, DAI or PYUSD.`);
    const circ = coin.circulating?.peggedUSD ?? 0;
    const prev = coin.circulatingPrevMonth?.peggedUSD ?? null;
    const chains = Object.entries(coin.chainCirculating || {}).map(([c, v]) => [c, v.current?.peggedUSD ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const peg = coin.price;
    const dev = peg ? ((peg - 1) * 100).toFixed(3) : 'n/a';
    const verdict = peg && Math.abs(peg - 1) > 0.01 ? 'Off peg' : 'On peg';
    const summary = `${verdict}. ${coin.name} (${coin.symbol}) has $${Math.round(circ).toLocaleString('en-US')} in circulation${prev ? ` (${(((circ - prev) / prev) * 100).toFixed(2)}% vs a month ago)` : ''}, priced at ${peg ?? 'n/a'} USD (${dev}% from 1.00), mostly on ${chains.map((c) => c[0]).join(', ')}. This is the supply that reserves must cover; the issuer's own attestation report is the proof of reserves and is not read here. Source: DefiLlama stablecoins.`;
    res.json({ status: 'ok', summary, answer: summary, verdict, symbol: coin.symbol, circulating_usd: circ, price_usd: peg, peg_deviation_percent: dev, source: 'DefiLlama stablecoins', confidence: 0.8, canonical: ['asset-reserve-attestation', coin.symbol.toLowerCase()].join(':'), checked_at: now() });
  } catch (e) { fail(res, 'ASSET_RESERVE_ATTESTATION', e); }
});

/* ---------- LIQUIDITY_DEPTH_VERIFY ---------- */
export const liquidityRouter = both(Router(), async (req, res) => {
  const p = params(req);
  const raw = get(p, ['pair', 'token', 'symbol', 'address', 'query', 'q', 'question']);
  if (!raw) return respondUnusableInput(res, 'I cannot verify liquidity because no token or pair was supplied. Pass a symbol, pair or token address as the pair or query parameter.');
  const addr = String(raw).match(/0x[a-fA-F0-9]{40}/)?.[0];
  const q = addr || String(raw).replace(/[^A-Za-z0-9/ ]/g, ' ').trim().split(/\s+/).slice(0, 3).join(' ');
  try {
    const j = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
    const list = (j.pairs || []).filter((x) => x.liquidity?.usd).sort((a, b) => b.liquidity.usd - a.liquidity.usd).slice(0, 3);
    if (!list.length) return respondUnusableInput(res, `No DEX pool with liquidity was found for ${quoteParam(raw)}.`);
    const t = list[0];
    const tot = list.reduce((s, x) => s + x.liquidity.usd, 0);
    const depth = tot > 5_000_000 ? 'Deep' : tot > 500_000 ? 'Adequate' : tot > 50_000 ? 'Thin' : 'Very thin';
    const summary = `${depth} liquidity. ${t.baseToken.symbol}/${t.quoteToken.symbol} on ${t.dexId} (${t.chainId}) holds $${Math.round(t.liquidity.usd).toLocaleString('en-US')} with 24h volume $${Math.round(t.volume?.h24 ?? 0).toLocaleString('en-US')}; the top ${list.length} pools together hold $${Math.round(tot).toLocaleString('en-US')}. Source: DexScreener.`;
    res.json({ status: 'ok', summary, answer: summary, depth, top_pool_liquidity_usd: t.liquidity.usd, total_top_liquidity_usd: tot, pools: list.map((x) => ({ dex: x.dexId, chain: x.chainId, pair: `${x.baseToken.symbol}/${x.quoteToken.symbol}`, liquidity_usd: x.liquidity.usd, volume_24h: x.volume?.h24 ?? 0, address: x.pairAddress })), source: 'DexScreener', confidence: 0.85, canonical: ['liquidity-depth-verify', q.toLowerCase()].join(':'), checked_at: now() });
  } catch (e) { fail(res, 'LIQUIDITY_DEPTH_VERIFY', e); }
});

/* ---------- API_HEALTH_CHECK / SERVER_UPTIME_MONITOR ---------- */
class ProbeError extends Error {}
function healthHandler(intent, kind) {
  return both(Router(), async (req, res) => {
    const p = params(req);
    const raw = get(p, ['url', 'endpoint', 'host', 'domain', 'server', 'api', 'query', 'q', 'question']);
    const found = raw && (String(raw).match(/https?:\/\/[^\s"'<>]+/i)?.[0] || String(raw).match(/\b[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>]*)?/i)?.[0]);
    if (!found) return respondUnusableInput(res, `I cannot run a ${kind} because no URL or host was supplied. Pass it as the url or query parameter.`);
    const url = /^https?:\/\//i.test(found) ? found : `https://${found}`;
    try {
      const parsed = parsePublicUrl(url, ProbeError, 'probed');
      await assertResolvesPublic(parsed, ProbeError, 'probed');
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        try {
          const r = await fetch(parsed, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'txlens-health/1.0' } });
          runs.push({ ok: r.status < 500, status: r.status, ms: Date.now() - t0 });
        } catch (e) { runs.push({ ok: false, status: 0, ms: Date.now() - t0, error: e.name }); }
      }
      const okN = runs.filter((r) => r.ok).length;
      const ms = runs.filter((r) => r.ok).map((r) => r.ms);
      const avg = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null;
      const state = okN === 3 ? 'Healthy' : okN > 0 ? 'Degraded' : 'Down';
      const summary = `${state}. ${parsed.hostname} answered ${okN} of 3 probes${avg != null ? ` with an average of ${avg} ms` : ''}; last HTTP status ${runs[runs.length - 1].status || 'no response'}. Checked ${now()}.`;
      res.json({ status: 'ok', summary, answer: summary, state, probes_ok: okN, probes: runs, avg_latency_ms: avg, confidence: 0.9, canonical: [kind, parsed.hostname].join(':'), checked_at: now() });
    } catch (e) {
      if (e instanceof ProbeError) return respondUnusableInput(res, `I cannot probe ${quoteParam(raw)}: ${e.message}.`);
      fail(res, intent, e);
    }
  });
}
export const apiHealthRouter = healthHandler('API_HEALTH_CHECK', 'api-health-check');
export const uptimeRouter = healthHandler('SERVER_UPTIME_MONITOR', 'server-uptime-monitor');

/* ---------- TWITTER_SEARCH ---------- */
// X has no search without a paid API key, so real public posts are read from
// Bluesky's public search and Hacker News (both keyless), next to whatever
// x.com pages the web index holds. Found live 2026-11: the web-only version
// took 15 to 35 seconds and usually led with "No X posts could be indexed".
const SOCIAL_FILLER = /\b(latest|recent|current|upcoming|tweets?|twitter|x\/twitter|on x|posts?|reactions?|discussion|what (?:are|is) (?:people|everyone) saying|people|saying|about|the|regarding|on|of|for|search|find|show me)\b/gi;

export function socialTerms(raw) {
  const words = String(raw).replace(SOCIAL_FILLER, ' ').replace(/[^\p{L}\p{N}#@' -]+/gu, ' ').replace(/\s{2,}/g, ' ').trim();
  return words || String(raw).trim();
}

async function blueskyPosts(term) {
  const tries = [term, term.split(' ').filter((w) => !/^\d|^(st|nd|rd|th)$/i.test(w)).slice(0, 3).join(' ')];
  for (const q of [...new Set(tries.filter(Boolean))]) {
    const j = await getJson(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=8&sort=top`, 7_000).catch(() => null);
    const posts = (j?.posts ?? []).filter((x) => x?.record?.text);
    if (posts.length) {
      return posts.slice(0, 5).map((x) => ({
        platform: 'Bluesky',
        author: `@${x.author?.handle}`,
        text: String(x.record.text).replace(/\s+/g, ' ').slice(0, 220),
        posted_at: x.record.createdAt ?? x.indexedAt ?? null,
        likes: x.likeCount ?? 0,
        reposts: x.repostCount ?? 0,
        url: `https://bsky.app/profile/${x.author?.handle}/post/${String(x.uri).split('/').pop()}`,
      }));
    }
  }
  return [];
}

async function hnPosts(term) {
  let j = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(term)}&tags=story&hitsPerPage=3`, 6_000).catch(() => null);
  if (!j?.hits?.length) {
    const short = term.split(' ').filter((w) => !/^\d/.test(w)).slice(0, 2).join(' ');
    if (short && short !== term) j = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(short)}&tags=story&hitsPerPage=3`, 5_000).catch(() => null);
  }
  return (j?.hits ?? []).filter((h) => h?.title).map((h) => ({
    platform: 'Hacker News', author: h.author ? `@${h.author}` : null, text: h.title, posted_at: h.created_at ?? null,
    likes: h.points ?? 0, reposts: null, url: `https://news.ycombinator.com/item?id=${h.objectID}`,
  }));
}

async function xPosts(term) {
  if (!hasWebSearchProvider()) return [];
  const r = await searchWeb(`${term} (site:x.com OR site:twitter.com)`, { topic: 'news', maxResults: 6, budgetMs: 7_000 }).catch(() => null);
  return (r?.results || []).filter((x) => /(^|\.)(x|twitter)\.com/i.test(x.url || '')).slice(0, 4).map((x) => ({
    platform: 'X', author: /x\.com\/([^/]+)/i.exec(x.url)?.[1] ? `@${/x\.com\/([^/]+)/i.exec(x.url)[1]}` : null,
    text: String(x.snippet || x.title || '').replace(/\s+/g, ' ').slice(0, 220), posted_at: null, likes: null, reposts: null, url: x.url,
  }));
}

export const twitterSearchRouter = both(Router(), async (req, res) => {
  const p = params(req);
  const raw = get(p, ['query', 'q', 'search', 'topic', 'hashtag', 'user', 'handle', 'question']);
  if (!raw) return respondUnusableInput(res, 'I cannot search posts because no search term was supplied. Pass it as the query parameter.');
  const term = socialTerms(raw);
  try {
    const [x, bsky, hn] = await Promise.all([xPosts(term), blueskyPosts(term), hnPosts(term)]);
    const posts = [...x, ...bsky, ...hn];
    const byPlatform = posts.reduce((acc, q) => ({ ...acc, [q.platform]: (acc[q.platform] ?? 0) + 1 }), {});
    const line = (q, i) => `${i + 1}. ${q.author ?? q.platform} on ${q.platform}${q.posted_at ? ` (${String(q.posted_at).slice(0, 10)}${q.likes != null ? `, ${q.likes} likes` : ''})` : ''}: "${q.text}"`;
    const summary = posts.length
      ? `${posts.length} public posts found about "${term}" (${Object.entries(byPlatform).map(([k, v]) => `${v} on ${k}`).join(', ')}). ${posts.slice(0, 6).map(line).join(' ')}${x.length ? '' : ' X itself has no public search without a paid API key, so posts were read from Bluesky and Hacker News.'}`
      : `No public posts about "${term}" were found on Bluesky, Hacker News or in the web index of x.com at request time. X itself has no public search without a paid API key.`;
    res.json({
      status: posts.length ? 'ok' : 'not_found', verdict: posts.length ? 'found' : 'not_found', found: posts.length > 0,
      summary, answer: summary, query: term, result_count: posts.length, by_platform: byPlatform,
      latest_at: posts.map((q) => q.posted_at).filter(Boolean).sort().pop() ?? null, results: posts,
      source: 'Bluesky public search, Hacker News (Algolia), web index of x.com',
      confidence: posts.length ? 0.8 : 0.5, canonical: ['twitter-search', term.toLowerCase()].join(':'), checked_at: now(),
    });
  } catch (e) { fail(res, 'TWITTER_SEARCH', e); }
});

/* ---------- EMBEDDING_GENERATION ---------- */
const DIMS = 256;
export function embed(text) {
  const v = new Float64Array(DIMS);
  const toks = String(text).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const grams = [];
  for (const t of toks) { grams.push(t); const w = `#${t}#`; for (let i = 0; i + 3 <= w.length; i++) grams.push(w.slice(i, i + 3)); }
  for (const g of grams) {
    const h = createHash('sha256').update(g).digest();
    const idx = h.readUInt16BE(0) % DIMS;
    v[idx] += h[2] & 1 ? 1 : -1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return Array.from(v, (x) => Number((x / n).toFixed(6)));
}
export const embeddingRouter = both(Router(), (req, res) => {
  const p = params(req);
  const raw = get(p, ['text', 'input', 'query', 'q', 'content', 'sentence', 'question']);
  if (!raw) return respondUnusableInput(res, 'I cannot make an embedding because no text was supplied. Pass it as the text or query parameter.');
  const vec = embed(String(raw).slice(0, 8000));
  const summary = `Embedding generated: ${DIMS} dimensions, unit length, deterministic hashed word and character trigram model (same text always gives the same vector, similar wording gives close vectors). First values: ${vec.slice(0, 6).join(', ')}.`;
  res.json({ status: 'ok', summary, answer: summary, model: 'hashed-ngram-256', dimensions: DIMS, embedding: vec, confidence: 0.9, canonical: ['embedding-generation', createHash('sha256').update(String(raw)).digest('hex').slice(0, 16)].join(':'), checked_at: now() });
});
