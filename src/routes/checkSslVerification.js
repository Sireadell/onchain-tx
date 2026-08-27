// SSL_VERIFICATION signal endpoint. Added 2026-08-25 — a real TLS
// handshake against the domain (lib/sslCheck.js), not a third-party API.
// Query param: domain (bare hostname, e.g. "example.com" — not a full URL).

import { Router } from 'express';
import { checkSslCertificate, SslConnectionError } from '../lib/sslCheck.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';

const router = Router();

// Deliberately permissive — real-world hostnames include hyphens,
// subdomains, and internationalized labels; this only rejects the obvious
// non-hostname cases (protocol prefix, path, whitespace) rather than
// re-implementing full hostname validation.
const DOMAIN_RE = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

async function handleSslVerification(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const domain = params?.domain;

  if (!domain) {
    return res.status(400).json({
      status: 'error',
      summary: 'must include a `domain` (bare hostname, e.g. "example.com") query parameter',
      confidence: 1.0,
      error: 'missing `domain` parameter',
    });
  }
  if (!DOMAIN_RE.test(domain)) {
    return res.status(400).json({
      status: 'error',
      summary: '`domain` must be a bare hostname, not a full URL — e.g. "example.com", not "https://example.com/path"',
      confidence: 1.0,
      error: 'malformed `domain` parameter',
    });
  }

  let result;
  try {
    result = await checkSslCertificate(domain);
  } catch (err) {
    if (err instanceof SslConnectionError) {
      const summary = `${domain} is unreachable, so its TLS/SSL certificate and chain cannot be verified. ${err.message}. When the host is reachable, inspect the leaf and intermediate certificates, confirm the chain reaches a trusted root, verify the Subject Alternative Name includes ${domain}, check validity dates and revocation status, and review supported TLS versions and cipher suites. Use openssl s_client -connect ${domain}:443 -servername ${domain} -showcerts or an SSL Labs server test.`;
      return res.json({
        query: domain,
        status: 'unreachable',
        summary,
        reason: summary,
        confidence: 1.0,
        canonical: ['ssl', domain, 'unreachable'].join(':'),
        valid: null,
        authorized: null,
        chain_complete: null,
        hostname_valid: null,
        unreachable_reason: err.message,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'SSL check could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'SSL check failed', confidence: 1.0, error: err.message });
  }

  const valid = result.authorized && result.daysUntilExpiry > 0;
  const summary = valid
    ? `${domain} has a valid certificate, expiring in ${result.daysUntilExpiry} days (issued by ${result.issuer?.O ?? result.issuer?.CN ?? 'unknown issuer'})`
    : `${domain}'s certificate is ${result.daysUntilExpiry <= 0 ? 'expired' : 'not trusted'}${result.authorizationError ? ` (${result.authorizationError})` : ''}`;

  res.json({
    query: domain,
    status: 'ok',
    summary,
    confidence: 1.0,
    canonical: ['ssl', domain, valid ? 'valid' : 'invalid', result.daysUntilExpiry].join(':'),
    valid,
    authorized: result.authorized,
    authorization_error: result.authorizationError,
    issuer: result.issuer?.O ?? result.issuer?.CN ?? null,
    valid_from: result.validFrom,
    valid_to: result.validTo,
    days_until_expiry: result.daysUntilExpiry,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleSslVerification(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleSslVerification(req, res)));

export default router;
