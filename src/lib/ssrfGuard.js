// Shared SSRF guard for any endpoint that fetches a caller-supplied URL from
// our own server. Without this, a caller could point an endpoint at
// internal/loopback/link-local addresses (169.254.169.254 is the
// cloud-metadata endpoint on most hosts, including Render) and read back
// whatever is there through what looks like an ordinary answer. Checked at
// the hostname level, then again on what the hostname resolves to, and
// again on every redirect hop, before any byte of the response is read.
//
// Originally two independent copies (src/lib/contentExtract.js and
// src/routes/checkUrlScan.js), written separately and found byte-identical
// on review 2026-09-17. Unified here so a future fix to the private-address
// rules cannot land in one copy and not the other. The error class is
// supplied by the caller so each site keeps throwing (and catching) its own
// error type; this module only owns the address-checking logic.

import dns from 'node:dns/promises';
import net from 'node:net';

export const BLOCKED_HOSTNAME_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home|.*\.lan|metadata\.google\.internal|0\.0\.0\.0)$/i;

export function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.test(lower)) return isPrivateIp(lower.replace(/^::ffff:/, ''));
    return /^(fc|fd|fe[89ab])/.test(lower);
  }
  return false;
}

// ErrorClass: the caller's own error type, so existing catch blocks (which
// check `instanceof ContentExtractError` / `instanceof UrlScanFetchError`)
// keep working unchanged. notScannableWord: "fetched" or "scanned", so the
// message still reads naturally at each call site.
export function parsePublicUrl(rawUrl, ErrorClass, notScannableWord = 'fetched') {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ErrorClass('not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ErrorClass('only http and https URLs are supported');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTNAME_RE.test(host) || isPrivateIp(host)) {
    throw new ErrorClass(`this URL points at a private or internal address, which cannot be ${notScannableWord}`);
  }
  return parsed;
}

// A public-looking hostname that resolves to a private address is the same
// hole with one extra step. The lookup result is advisory (the fetch does
// its own resolution), which still closes the obvious case.
export async function assertResolvesPublic(parsed, ErrorClass, notScannableWord = 'fetched') {
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw new ErrorClass('the host could not be found (DNS lookup failed)');
  }
  if (!records.length) throw new ErrorClass('the host could not be found (DNS lookup failed)');
  if (records.some((r) => isPrivateIp(r.address))) {
    throw new ErrorClass(`this URL points at a private or internal address, which cannot be ${notScannableWord}`);
  }
}
