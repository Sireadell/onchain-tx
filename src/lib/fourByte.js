const cache = new Map();
const LOOKUP_TIMEOUT_MS = 2_000;

export async function lookupMethodSignature(input) {
  if (typeof input !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(input) || input === '0x') return null;
  const selector = input.slice(0, 10).toLowerCase();
  if (cache.has(selector)) return cache.get(selector);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    const signature = body.results?.[0]?.text_signature || null;
    cache.set(selector, signature);
    return signature;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function resetMethodSignatureCache() {
  cache.clear();
}
