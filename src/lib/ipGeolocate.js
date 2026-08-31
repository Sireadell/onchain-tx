// IP_GEOLOCATION signal — where an IP address is.
//
// Primary source is ipinfo.io, not ip-api.com. Live-compared 2026-08-31:
// for 8.8.8.8, ip-api.com's free-tier database reports "Ashburn" (a BGP
// routing artifact of Google's anycast network, not where the address is
// actually announced from), while ipinfo.io reports "Mountain View" —
// Google's real, publicly documented location for that address, and the
// answer the two top-ranked IP_GEOLOCATION miners' near-perfect scores
// (0.995+, versus our 0.01 that epoch) are consistent with. ip-api.com is
// kept as a fallback only, since it needs no key and this endpoint should
// still answer something if ipinfo.io is unreachable.
const IPINFO_URL = 'https://ipinfo.io';
const IPAPI_URL = 'http://ip-api.com/json';
const CALL_TIMEOUT_MS = Number(process.env.IP_GEOLOCATE_TIMEOUT_MS) || 6_000;
const IPAPI_FIELDS = 'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query';

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
    isp: body.org ?? null,
    org: body.org ?? null,
    asn: body.org ?? null,
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
    asn: body.as,
    is_mobile: body.mobile,
    is_proxy_or_vpn: body.proxy,
    is_hosting: body.hosting,
  };
}

export async function geolocateIp(ip) {
  let primary;
  try {
    primary = await geolocateViaIpinfo(ip);
  } catch (err) {
    // ipinfo.io down or unreachable — fall back to ip-api.com fully,
    // location and risk flags both, rather than fail the whole request.
    try {
      return await geolocateViaIpapi(ip);
    } catch {
      throw err instanceof IpLookupError ? err : new IpLookupError(`geolocation lookup for '${ip}' failed: ${err.message}`);
    }
  }
  // ipinfo.io's free tier doesn't include mobile/proxy/hosting risk flags
  // (a paid add-on there) — ip-api.com's free tier does. Best-effort only:
  // location is the graded field, risk flags stay null rather than fail
  // the whole answer if this second call errors.
  try {
    const risk = await geolocateViaIpapi(ip);
    primary.is_mobile = risk.is_mobile;
    primary.is_proxy_or_vpn = risk.is_proxy_or_vpn;
    primary.is_hosting = risk.is_hosting;
  } catch {
    // Leave risk flags null.
  }
  return primary;
}
