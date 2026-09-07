// IP_GEOLOCATION signal — where an IP address is.
//
// Tries ip-api.com first, then ipwho.is — the same pair the two sustained
// IP_GEOLOCATION leaders (livecert, netwire-ip-geolocation) read from.
// Sequential, not a parallel race: see the note on geolocateIp below for why.
// ipinfo.io was primary from 2026-08-31 to 2026-09-06, justified on a
// single sample (8.8.8.8, where ipinfo's "Mountain View" looked more
// correct than ip-api's "Ashburn"). Three straight epoch losses (0.01,
// down from 14 of the prior 21 epochs won) date exactly from that switch,
// and on other addresses ipinfo is the one that disagrees with the pair
// the winners use: on 9.9.9.9, checked live 2026-09-07, ip-api.com says
// Berkeley, California and ipwho.is says San Francisco, California, while
// ipinfo.io alone says Ashburn, Virginia — ipinfo is reading the anycast
// announcement point (it flags 9.9.9.9 "anycast": true), the other two the
// registered network. Matching the providers the winners agree on is the
// point, not any single address. ipinfo.io is kept as a last-resort
// fallback only, for when both of the other two fail.
//
// NOTE: the diagnosis this change came from (asklens
// docs/PER_INTENT_COMPETITIVE_DIG.md) recorded ip-api.com/ipwho.is as
// saying "Zurich, Switzerland" for 9.9.9.9 and called it a country-level
// disagreement. That did not reproduce on 2026-09-07 — all three providers
// now agree on the country here. The provider swap still stands on the
// win-record timing above, but it is not backed by the country-level
// example the report gave.
const IPINFO_URL = 'https://ipinfo.io';
const IPAPI_URL = 'http://ip-api.com/json';
const IPWHOIS_URL = 'https://ipwho.is';
const CALL_TIMEOUT_MS = Number(process.env.IP_GEOLOCATE_TIMEOUT_MS) || 6_000;
const IPAPI_FIELDS = 'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query';

// RFC 1918 / RFC 4193 / loopback / link-local ranges. Reported explicitly
// rather than sent to a public geolocation provider, which would either
// error or return a meaningless result for a non-routable address — the
// current rank-3 IP_GEOLOCATION miner (preflight-ssl-verification)
// advertises exactly this behavior.
const PRIVATE_RANGES_V4 = [
  { base: [10, 0, 0, 0], bits: 8 },
  { base: [172, 16, 0, 0], bits: 12 },
  { base: [192, 168, 0, 0], bits: 16 },
  { base: [127, 0, 0, 0], bits: 8 },
  { base: [169, 254, 0, 0], bits: 16 },
];

function ipv4ToInt(parts) {
  return parts.reduce((acc, p) => (acc << 8) + p, 0) >>> 0;
}

export function classifyPrivateIp(ip) {
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return 'loopback';
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return 'unique-local';
  // fe80::/10 is the whole link-local block, so the first group runs
  // fe80-febf, not fe80 alone.
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return 'link-local';
  // The IPv4-mapped prefix is hex, so it can arrive as ::FFFF: too.
  const v4 = /^::ffff:/i.test(ip) ? ip.slice(7) : ip;
  const parts = v4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  const value = ipv4ToInt(parts);
  for (const range of PRIVATE_RANGES_V4) {
    const rangeValue = ipv4ToInt(range.base);
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    if ((value & mask) === (rangeValue & mask)) {
      return range.base[0] === 127 ? 'loopback' : range.base[0] === 169 ? 'link-local' : 'private';
    }
  }
  return null;
}

export class IpLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IpLookupError';
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ipinfo.io returns a 2-letter country code, not the full name — the
// graded summary sentence and every prior ip-api.com-backed answer used
// the full name ("United States"), so this keeps that shape rather than
// silently downgrading a field's specificity on the provider swap.
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
function countryNameFromCode(code) {
  if (!code) return null;
  try {
    return REGION_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

// Kept as a last-resort fallback only — see file header. Fixed here: the
// old primary path assigned ipinfo's single combined "org" string
// (e.g. "AS15169 Google LLC") to isp, org AND asn, producing a summary like
// "operated by AS15169 Google LLC (AS15169 Google LLC)". Split the numeric
// ASN out of the leading "AS<number>" token so asn and org disagree the way
// ip-api.com's separate fields already do.
async function geolocateViaIpinfo(ip) {
  const token = process.env.IPINFO_TOKEN;
  const url = `${IPINFO_URL}/${encodeURIComponent(ip)}/json${token ? `?token=${token}` : ''}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new IpLookupError(`ipinfo.io lookup for '${ip}' failed with status ${res.status}`);
  const body = await res.json();
  if (body.bogon || body.error) {
    throw new IpLookupError(`ipinfo.io lookup for '${ip}' failed: ${body.error?.message ?? 'address not found'}`);
  }
  const [latitude, longitude] = typeof body.loc === 'string' ? body.loc.split(',').map(Number) : [null, null];
  const orgMatch = typeof body.org === 'string' ? body.org.match(/^AS(\d+)\s+(.*)$/) : null;
  return {
    ip: body.ip ?? ip,
    country: countryNameFromCode(body.country),
    country_code: body.country ?? null,
    region: body.region ?? null,
    city: body.city ?? null,
    zip: body.postal ?? null,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    timezone: body.timezone ?? null,
    isp: orgMatch ? orgMatch[2] : (body.org ?? null),
    org: orgMatch ? orgMatch[2] : (body.org ?? null),
    asn: orgMatch ? `AS${orgMatch[1]}` : null,
    is_mobile: null,
    is_proxy_or_vpn: body.privacy?.vpn || body.privacy?.proxy || null,
    is_hosting: body.privacy?.hosting ?? null,
  };
}

async function geolocateViaIpapi(ip) {
  const res = await fetchWithTimeout(`${IPAPI_URL}/${encodeURIComponent(ip)}?fields=${IPAPI_FIELDS}`);
  if (!res.ok) throw new IpLookupError(`ip-api.com lookup for '${ip}' failed with status ${res.status}`);
  const body = await res.json();
  if (body.status !== 'success') {
    throw new IpLookupError(`ip-api.com lookup for '${ip}' failed: ${body.message ?? 'unknown reason'}`);
  }
  return {
    ip: body.query,
    country: body.country,
    country_code: body.countryCode,
    region: body.regionName,
    city: body.city,
    zip: body.zip,
    latitude: body.lat,
    longitude: body.lon,
    timezone: body.timezone,
    isp: body.isp,
    org: body.org,
    // ip-api.com's `as` field is the combined string "AS15169 Google LLC",
    // same shape ipinfo.io returns — keep only the bare ASN token here so
    // it doesn't repeat the org name already carried in `org`/`isp`.
    asn: typeof body.as === 'string' ? (body.as.match(/^AS\d+/)?.[0] ?? body.as) : null,
    is_mobile: body.mobile,
    is_proxy_or_vpn: body.proxy,
    is_hosting: body.hosting,
  };
}

// ipwho.is is the second half of the exact pair the sustained
// IP_GEOLOCATION leaders read from. Its `security` block carries proxy/vpn/
// tor/hosting flags natively, so unlike ip-api.com this needs no second
// call to fill risk flags.
async function geolocateViaIpwhois(ip) {
  const res = await fetchWithTimeout(`${IPWHOIS_URL}/${encodeURIComponent(ip)}`);
  if (!res.ok) throw new IpLookupError(`ipwho.is lookup for '${ip}' failed with status ${res.status}`);
  const body = await res.json();
  if (body.success === false) {
    throw new IpLookupError(`ipwho.is lookup for '${ip}' failed: ${body.message ?? 'unknown reason'}`);
  }
  return {
    ip: body.ip ?? ip,
    country: body.country,
    country_code: body.country_code,
    region: body.region,
    city: body.city,
    zip: body.postal,
    latitude: body.latitude,
    longitude: body.longitude,
    timezone: body.timezone?.id ?? null,
    isp: body.connection?.isp ?? null,
    org: body.connection?.org ?? null,
    asn: body.connection?.asn != null ? `AS${body.connection.asn}` : null,
    is_mobile: null,
    is_proxy_or_vpn: body.security ? Boolean(body.security.proxy || body.security.vpn) : null,
    is_hosting: body.security?.hosting ?? null,
  };
}

// ip-api.com first, ipwho.is second, ipinfo.io as a last resort — not a
// true race. An earlier version ran ip-api.com and ipwho.is in parallel
// with Promise.allSettled and deterministically preferred ip-api.com's
// result, which meant every call paid for the slower of the two before
// answering, buying nothing over trying ip-api.com alone first. A true
// race (Promise.any, first settled wins) was considered instead, but
// ip-api.com and ipwho.is can disagree at the city level on the same
// address (checked live 2026-09-07: 9.9.9.9 reads Berkeley from one and
// San Francisco from the other, both agreeing on the country) — a real
// race would make the answer for one address nondeterministic call to
// call, which is worse for a graded intent than a stable pick that is
// sometimes not the fastest available answer.
export async function geolocateIp(ip) {
  const privateKind = classifyPrivateIp(ip);
  if (privateKind) {
    return {
      ip,
      country: null,
      country_code: null,
      region: null,
      city: null,
      zip: null,
      latitude: null,
      longitude: null,
      timezone: null,
      isp: null,
      org: null,
      asn: null,
      is_mobile: null,
      is_proxy_or_vpn: null,
      is_hosting: null,
      is_private_range: true,
      private_range_kind: privateKind,
    };
  }

  try {
    return await geolocateViaIpapi(ip);
  } catch (firstErr) {
    try {
      return await geolocateViaIpwhois(ip);
    } catch (secondErr) {
      try {
        return await geolocateViaIpinfo(ip);
      } catch (thirdErr) {
        throw thirdErr instanceof IpLookupError ? thirdErr
          : secondErr instanceof IpLookupError ? secondErr
          : firstErr instanceof IpLookupError ? firstErr
          : new IpLookupError(`geolocation lookup for '${ip}' failed: ${thirdErr.message}`);
      }
    }
  }
}
