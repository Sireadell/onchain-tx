// Resolves an ENS name such as vitalik.eth to the address it points to, so a
// wallet question that names a person instead of pasting an address still gets
// a real answer. Well-known names are answered from a small table with no
// network call; any other .eth name is looked up through the public ENS
// resolver API and cached.

const ENS_WELL_KNOWN = {
  'vitalik.eth': '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
};

const ENS_NAME_RE = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.eth\b/i;
const ENS_TIMEOUT_MS = Number(process.env.ENS_TIMEOUT_MS) || 4_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

export function findEnsName(text) {
  if (typeof text !== 'string') return null;
  return text.match(ENS_NAME_RE)?.[0]?.toLowerCase() ?? null;
}

export function __clearEnsCacheForTesting() {
  cache.clear();
}

export async function resolveEnsName(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!ENS_NAME_RE.test(key)) return null;
  if (ENS_WELL_KNOWN[key]) return ENS_WELL_KNOWN[key];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.storedAt < CACHE_TTL_MS) return hit.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENS_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.ensideas.com/ens/resolve/${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const address = typeof body?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.address) ? body.address : null;
    cache.set(key, { value: address, storedAt: Date.now() });
    return address;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
