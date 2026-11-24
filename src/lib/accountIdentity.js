// Who owns a social handle, from Wikidata's public record of official
// accounts (X username P2002, Instagram P2003, Mastodon P4033, Bluesky
// P12361, YouTube handle P11245). A handle Wikidata lists as the account of a
// known person or organisation is identity evidence that it is not a bot
// farm; it says nothing about posting rate, which X does not publish.

const PROPS = { x: 'P2002', instagram: 'P2003', mastodon: 'P4033', bluesky: 'P12361', youtube: 'P11245' };

export function readHandle(text) {
  const t = String(text ?? '');
  const url = t.match(/(?:twitter|x)\.com\/@?([A-Za-z0-9_]{1,15})\b/i);
  if (url) return { handle: url[1], platform: 'x' };
  const insta = t.match(/instagram\.com\/([A-Za-z0-9_.]{1,30})/i);
  if (insta) return { handle: insta[1], platform: 'instagram' };
  const bsky = t.match(/@?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.bsky\.social)\b/i);
  if (bsky) return { handle: bsky[1], platform: 'bluesky' };
  // A bare @handle, not the user part of an email address.
  const at = t.match(/(?:^|[\s(“"'])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_@.]*\.[a-z]{2,})/);
  if (at) return { handle: at[1], platform: /instagram/i.test(t) ? 'instagram' : 'x' };
  return null;
}

async function getJson(url, ms = 6000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'User-Agent': 'txlens-miner/1.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
  return res.json();
}

const SPARQL = 'https://query.wikidata.org/sparql';
const cache = new Map();

async function withRetry(fn) {
  try { return await fn(); } catch (err) {
    if (!/429|5\d\d/.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 1200));
    return fn();
  }
}

// One SPARQL query per handle (the search API needs two calls and rate
// limits sooner). The handle is matched as written and in lower case.
export async function lookupAccount({ handle, platform }, fetchJson = getJson) {
  const prop = PROPS[platform] ?? PROPS.x;
  const key = `${prop}:${handle.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const safe = handle.replace(/[^A-Za-z0-9_.-]/g, '');
  const forms = [...new Set([safe, safe.toLowerCase()])].map((h) => `"${h}"`).join(' ');
  const q = `SELECT ?item ?itemLabel ?itemDescription WHERE { VALUES ?h { ${forms} } ?item wdt:${prop} ?h . `
    + 'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 1';
  const body = await withRetry(() => fetchJson(`${SPARQL}?format=json&query=${encodeURIComponent(q)}`, 8000));
  const row = body?.results?.bindings?.[0];
  const id = row?.item?.value?.split('/').pop();
  const name = row?.itemLabel?.value;
  const out = id && name && name !== id
    ? { wikidata_id: id, name, description: row?.itemDescription?.value ?? null, source: `https://www.wikidata.org/wiki/${id}` }
    : null;
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}
