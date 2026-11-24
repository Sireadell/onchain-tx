// Full holder count for a Solana token, read from Jupiter's public token
// index (no key needed). A Solana node cannot count holders, it only lists the
// 20 largest accounts, so the count has to come from an indexer. Only a count
// that Jupiter returns for this exact mint is used. Anything else (no match,
// no count, slow or down) gives null and the route says plainly that no count
// is available.

import { getJson } from './liveJson.js';

export const HOLDER_SOURCE = 'Jupiter token index';
const HOLDER_URL = 'https://lite-api.jup.ag/tokens/v2/search?query=';
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export function resetHolderCache() { cache.clear(); }

export async function fetchSolanaHolderCount(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const rows = await getJson(HOLDER_URL + encodeURIComponent(mint), { timeoutMs: 6000 });
    const row = Array.isArray(rows) ? rows.find((r) => r && r.id === mint) : null;
    const n = row?.holderCount;
    if (Number.isSafeInteger(n) && n > 0) value = { count: n, source: HOLDER_SOURCE };
  } catch {
    value = null;
  }
  // Remember misses for a short time too, so a down source cannot stall every request.
  cache.set(mint, { at: Date.now(), value });
  return value;
}
