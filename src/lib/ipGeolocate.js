// IP_GEOLOCATION signal — where an IP address is, via ip-api.com's free
// tier (no key, 45 requests/minute, plain HTTP only — the provider does
// not offer HTTPS on the free tier).

const GEO_URL = 'http://ip-api.com/json';
const CALL_TIMEOUT_MS = Number(process.env.IP_GEOLOCATE_TIMEOUT_MS) || 6_000;
// mobile/proxy/hosting/as are free-tier fields the competing IP_GEOLOCATION
// miner (iplocate) charges for as "privacy/risk flags" — ip-api.com already
// includes them at no extra cost, confirmed live 2026-08-29.
const FIELDS = 'status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query';

export class IpLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IpLookupError';
  }
}

export async function geolocateIp(ip) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${GEO_URL}/${encodeURIComponent(ip)}?fields=${FIELDS}`, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new IpLookupError(`geolocation lookup for '${ip}' timed out after ${CALL_TIMEOUT_MS}ms`);
    throw new IpLookupError(`geolocation lookup for '${ip}' failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new IpLookupError(`geolocation lookup for '${ip}' failed with status ${res.status}`);

  const body = await res.json();
  if (body.status !== 'success') {
    throw new IpLookupError(`geolocation lookup for '${ip}' failed: ${body.message ?? 'unknown reason'}`);
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
