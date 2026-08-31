// IP_GEOLOCATION signal endpoint. A real lookup (lib/ipGeolocate.js,
// ip-api.com) for a caller-supplied IPv4 address, not a generated guess.
// Query param: ip (a bare IPv4 address, or a question naming one).

import { Router } from 'express';
import { geolocateIp, IpLookupError } from '../lib/ipGeolocate.js';
import { extractIp } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';

const router = Router();

export async function handleIpGeolocation(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawIp = params?.ip ?? params?.query ?? params?.q ?? params?.question ?? params?.address;
  const ip = extractIp(rawIp);

  if (!rawIp) {
    return respondUnusableInput(
      res,
      'I cannot geolocate an IP because none was supplied. Pass an IPv4 or IPv6 address such as "8.8.8.8" as the ip parameter and I will report its country, region, city, coordinates, timezone, network owner, and whether it is a proxy, VPN or datacenter address.',
    );
  }
  if (!ip) {
    return respondUnusableInput(
      res,
      `I cannot find an IP address in ${quoteParam(rawIp)}. Pass a bare IPv4 or IPv6 address such as "8.8.8.8" or "2001:4860:4860::8888", or a question naming one.`,
    );
  }

  let result;
  try {
    result = await geolocateIp(ip);
  } catch (err) {
    if (err instanceof IpLookupError) {
      return respondUnusableInput(res, `I cannot geolocate ${quoteParam(ip)}: ${err.message}`);
    }
    return res.status(502).json({ status: 'error', summary: 'IP geolocation failed', confidence: 1.0, error: err.message });
  }

  // Keep the graded location phrase complete. Each part is conditional so
  // a provider response that omits city or region still reads naturally.
  const summary = `${result.ip} is located in ${[result.city, result.region, result.country].filter(Boolean).join(', ')}, operated by ${result.isp}${result.asn ? ` (${result.asn})` : ''}.`;

  res.json({
    query: rawIp,
    status: 'ok',
    summary,
    // Not 1.0: city-level IP geolocation is genuinely uncertain. Checked
    // live 2026-08-29, this source and the competing miner on this intent
    // disagree on the city for 8.8.8.8 (Ashburn versus San Jose) while
    // agreeing on the country, so claiming certainty would be false.
    confidence: 0.95,
    canonical: ['ip-geo', result.ip].join(':'),
    ip: result.ip,
    country: result.country,
    country_code: result.country_code,
    region: result.region,
    city: result.city,
    zip: result.zip,
    latitude: result.latitude,
    longitude: result.longitude,
    timezone: result.timezone,
    isp: result.isp,
    org: result.org,
    asn: result.asn,
    is_mobile: result.is_mobile,
    is_proxy_or_vpn: result.is_proxy_or_vpn,
    is_hosting: result.is_hosting,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleIpGeolocation(req, res));
router.post('/', (req, res) => handleIpGeolocation(req, res));

export default router;
