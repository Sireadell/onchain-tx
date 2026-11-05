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

function fail(res, intent, err) {
  return res.status(502).json({ status: 'error', summary: `${intent} is temporarily unavailable. Retry shortly.`, confidence: 0, error: String(err.message || err) });
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
export const airQualityRouter = both(Router(), async (req, res) => {
  const p = params(req);
  const raw = get(p, ['city', 'location', 'place', 'query', 'q', 'question']);
  if (!raw) return respondUnusableInput(res, 'I cannot report air quality because no place was supplied. Pass a city as the city or query parameter.');
  const place = stripLead(raw) || String(raw);
  try {
    const g = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`);
    const hit = g?.results?.[0];
    if (!hit) return respondUnusableInput(res, `I could not find a place called ${quoteParam(place)}. Try a city name.`);
    const a = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${hit.latitude}&longitude=${hit.longitude}&current=us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide`);
    const c = a?.current;
    if (!c || c.us_aqi == null) return respondUnusableInput(res, `No air quality reading is available for ${hit.name} right now.`);
    const band = aqiBand(c.us_aqi);
    const where = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
    const summary = `Air quality in ${where} is ${band}: US AQI ${c.us_aqi} (European AQI ${c.european_aqi}), PM2.5 ${c.pm2_5} ug/m3, PM10 ${c.pm10} ug/m3, ozone ${c.ozone} ug/m3, NO2 ${c.nitrogen_dioxide} ug/m3, as of ${c.time} UTC.`;
    res.json({ status: 'ok', summary, answer: summary, us_aqi: c.us_aqi, european_aqi: c.european_aqi, category: band, pm2_5: c.pm2_5, pm10: c.pm10, location: where, source: 'Open-Meteo air quality', confidence: 0.9, canonical: ['air-quality', hit.name.toLowerCase()].join(':'), checked_at: now() });
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
export const twitterSearchRouter = both(Router(), async (req, res) => {
  const p = params(req);
  const raw = get(p, ['query', 'q', 'search', 'topic', 'hashtag', 'user', 'handle', 'question']);
  if (!raw) return respondUnusableInput(res, 'I cannot search posts because no search term was supplied. Pass it as the query parameter.');
  if (!hasWebSearchProvider()) return res.status(503).json({ status: 'error', summary: 'Post search is not configured on this deployment.', confidence: 0 });
  const term = String(raw).replace(/^\s*(?:search\s+)?(?:twitter|x|tweets?)\s+(?:for|about)?\s*/i, '').trim() || String(raw);
  try {
    let r = await searchWeb(`${term} (site:x.com OR site:twitter.com)`, { topic: 'news', maxResults: 6 });
    let posts = (r.results || []).filter((x) => /(^|\.)(x|twitter)\.com/i.test(x.url || '')).slice(0, 6);
    if (!posts.length) {
      r = await searchWeb(`what are people saying on Twitter X about ${term}`, { topic: 'news', maxResults: 6 });
      posts = (r.results || []).filter((x) => /(^|\.)(x|twitter)\.com/i.test(x.url || '')).slice(0, 6);
    }
    const summary = posts.length
      ? `Public posts on X about ${quoteParam(term)}: ${posts.map((x) => `${(x.title || x.content || '').replace(/\s+/g, ' ').slice(0, 140)} (${x.url})`).join(' | ')}`
      : (r.answer ? `No X posts could be indexed directly; current public discussion: ${String(r.answer)}` : `No public X posts were found for ${quoteParam(term)}.`);
    res.json({ status: 'ok', summary, answer: summary, result_count: posts.length, results: posts, source: 'web index of x.com', confidence: posts.length ? 0.75 : 0.3, canonical: ['twitter-search', term.toLowerCase()].join(':'), checked_at: now() });
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
