// THREAT_IP_REPUTATION signal endpoint. Given an IP or domain, checks
// reputation via AbuseIPDB and AlienVault OTX free APIs. No API key needed
// for OTX; AbuseIPDB free tier is rate-limited. Falls back to a threat
// summary if both fail.

import { Router } from 'express';
import { extractIp, extractHostname, firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';

const router = Router();

const OTX_BASE = 'https://otx.alienvault.com/api/v1/indicators';
const OTX_TIMEOUT_MS = 10_000;
const ABUSEIPDB_BASE = 'https://api.abuseipdb.com/api/v2';
const ABUSEIPDB_TIMEOUT_MS = 10_000;

// OTX public endpoint is occasionally flaky on first connection
const OTX_MAX_ATTEMPTS = 2;
const ABUSEIPDB_MAX_ATTEMPTS = 1;

const MAX_INPUT_CHARS = 500;

class OtxError extends Error {}
class AbuseIPDBError extends Error {}

async function fetchOtx(path) {
  let lastErr;
  for (let attempt = 1; attempt <= OTX_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OTX_TIMEOUT_MS);
    try {
      const res = await fetch(`${OTX_BASE}/${path}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TelegraphTxLensBot/1.0; +https://telegraphprotocol.com)' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new OtxError(`OTX request failed with status ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') lastErr = new OtxError('OTX did not respond in time');
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof OtxError ? lastErr : new OtxError(String(lastErr?.message ?? lastErr));
}

async function fetchAbuseIPDB(ip) {
  const apiKey = process.env.ABUSEIPDB_API_KEY;
  if (!apiKey) {
    return { unavailable: true, reason: 'ABUSEIPDB_API_KEY not configured' };
  }

  let lastErr;
  for (let attempt = 1; attempt <= ABUSEIPDB_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ABUSEIPDB_TIMEOUT_MS);
    try {
      const params = new URLSearchParams({ ipAddress: ip, maxAgeInDays: '90' });
      const res = await fetch(`${ABUSEIPDB_BASE}/check?${params.toString()}`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Key: apiKey,
          Accept: 'application/json',
        },
      });
      if (res.status === 429) {
        return { unavailable: true, reason: 'rate limited' };
      }
      if (!res.ok) throw new AbuseIPDBError(`AbuseIPDB request failed with status ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') lastErr = new AbuseIPDBError('AbuseIPDB did not respond in time');
    } finally {
      clearTimeout(timer);
    }
  }
  return { unavailable: true, reason: lastErr?.message ?? 'unknown error' };
}

function getThreatSummary(value, valueType, abuseData, otxData) {
  const parts = [];
  let threatScore = 0;
  let isMalicious = false;

  // Process AbuseIPDB data
  if (abuseData && !abuseData.unavailable && abuseData.data) {
    const score = abuseData.data.abuseConfidenceScore || 0;
    const reports = abuseData.data.totalReports || 0;
    threatScore = Math.max(threatScore, score);
    if (score > 75) {
      parts.push(`AbuseIPDB reports ${score}% confidence of abuse from ${reports} total reports.`);
      isMalicious = true;
    } else if (score > 25) {
      parts.push(`AbuseIPDB reports ${score}% confidence of abuse from ${reports} reports.`);
      isMalicious = true;
    } else if (score > 0) {
      parts.push(`AbuseIPDB has ${score}% confidence and ${reports} reports.`);
    }
  }

  // Process OTX data
  if (otxData) {
    const pulseCount = otxData.pulse_info?.count || 0;
    const reputation = otxData.reputation || null;
    const pulseNames = (otxData.pulse_info?.pulses || []).slice(0, 2).map((p) => p.name).filter(Boolean);

    if (reputation !== null && reputation < 0) {
      threatScore = Math.max(threatScore, 80);
      isMalicious = true;
    }

    if (pulseCount > 0) {
      parts.push(`AlienVault OTX lists it in ${pulseCount} threat pulse${pulseCount === 1 ? '' : 's'}${pulseNames.length ? ` (${pulseNames.join(', ')})` : ''}.`);
      isMalicious = true;
    } else if (reputation !== null) {
      parts.push(`AlienVault OTX reputation score: ${reputation}.`);
    }
  }

  let summary;
  if (isMalicious) {
    summary = `${value} is flagged as a known threat indicator`;
    if (valueType === 'ip') summary += ' IP address';
    else if (valueType === 'domain') summary += ' domain';
    summary += '. ';
    summary += parts.length > 0 ? parts.join(' ') : 'See threat intelligence sources below.';
  } else {
    summary = `${value} has no known malicious activity reported on queried threat-intelligence sources`;
    if (valueType === 'ip') summary += ' (IP)';
    else if (valueType === 'domain') summary += ' (domain)';
    summary += '. This is an absence of reported activity, not a guarantee of safety.';
    if (parts.length > 0) summary += ' ' + parts.join(' ');
  }

  return { summary, threatScore, isMalicious };
}

async function handleThreatIpReputation(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawInput = firstUsableValue(
    params?.ip,
    params?.domain,
    params?.indicator,
    params?.ioc,
    params?.host,
    params?.query,
    params?.q,
    params?.question,
    params?.text,
    params?.input,
  );

  if (!rawInput) {
    return respondUnusableInput(
      res,
      'I cannot check threat reputation because no IP or domain was supplied. Pass an IP address or domain name as the ip or domain parameter.',
    );
  }

  const text = String(rawInput).trim().slice(0, MAX_INPUT_CHARS);

  // Try to extract IP or domain
  const ip = extractIp(text);
  const domain = !ip ? extractHostname(text) : null;
  const value = ip || domain;
  const valueType = ip ? 'ip' : domain ? 'domain' : null;

  if (!value) {
    return respondUnusableInput(
      res,
      `I cannot determine a threat reputation for ${quoteParam(rawInput)} because it does not appear to be a valid IP address or domain name. Pass an IPv4 or IPv6 address or a hostname.`,
    );
  }

  // Query both sources in parallel, allowing failures
  let abuseData = null;
  let otxData = null;

  if (ip) {
    // Query AbuseIPDB for IPs
    try {
      abuseData = await fetchAbuseIPDB(ip);
    } catch (err) {
      // Silently continue if AbuseIPDB fails
    }

    // Query OTX for IP
    try {
      otxData = await fetchOtx(`IPv4/${encodeURIComponent(ip)}/general`);
    } catch (err) {
      // Silently continue if OTX fails
    }
  } else if (domain) {
    // Query OTX for domain
    try {
      otxData = await fetchOtx(`hostname/${encodeURIComponent(domain)}/general`);
    } catch (err) {
      // Silently continue if OTX fails
    }
  }

  const info = getThreatSummary(value, valueType, abuseData, otxData);

  // Determine confidence based on what sources succeeded
  let confidence = 0.5;
  let sources = [];

  if (abuseData && !abuseData.unavailable) {
    confidence = Math.max(confidence, 0.75);
    sources.push('AbuseIPDB');
  }
  if (otxData) {
    confidence = Math.max(confidence, 0.75);
    sources.push('AlienVault OTX');
  }

  if (sources.length === 0) {
    confidence = 0.3;
    sources.push('timeout or unavailable');
  }

  res.json({
    query: String(rawInput).slice(0, MAX_INPUT_CHARS),
    indicator: value,
    indicator_type: valueType,
    status: 'ok',
    summary: info.summary,
    confidence,
    canonical: ['threat-ip-reputation', valueType, value].join(':'),
    threat_score: info.threatScore,
    is_malicious: info.isMalicious,
    sources_checked: sources,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleThreatIpReputation(req, res));
router.post('/', (req, res) => handleThreatIpReputation(req, res));

export default router;
