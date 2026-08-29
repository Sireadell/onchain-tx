// SSL_VERIFICATION signal endpoint. Added 2026-08-25 — a real TLS
// handshake against the domain (lib/sslCheck.js), not a third-party API.
// Query param: domain (bare hostname, e.g. "example.com" — not a full URL).

import { Router } from 'express';
import { checkSslCertificate, SslConnectionError } from '../lib/sslCheck.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { quoteParam, respondUnusableInput } from '../lib/unusableInput.js';
import { extractHostname } from '../lib/entityExtract.js';

const router = Router();

// Deliberately permissive — real-world hostnames include hyphens,
// subdomains, and internationalized labels; this only rejects the obvious
// non-hostname cases (protocol prefix, path, whitespace) rather than
// re-implementing full hostname validation.
const DOMAIN_RE = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

async function handleSslVerification(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawDomain = params?.domain;
  // Exact bare hostname first; if that fails, pull a hostname out of a
  // full URL, a "host:port" pair, or a whole question naming the domain,
  // rather than rejecting outright. Live-checked 2026-08-29: a competing
  // SSL miner answers all three of these forms; we were rejecting them.
  // See entityExtract.js.
  const domain = rawDomain && DOMAIN_RE.test(rawDomain) ? rawDomain : extractHostname(rawDomain);

  if (!rawDomain) {
    return respondUnusableInput(
      res,
      'I cannot check a certificate because no domain was supplied. Pass a bare hostname such as "example.com" as the domain parameter and I will report whether its TLS certificate is valid, who issued it, when it expires, and any problems in its trust chain.',
    );
  }
  if (!domain) {
    return respondUnusableInput(
      res,
      `I cannot check a certificate for ${quoteParam(rawDomain)} because I cannot find a hostname in it. Pass a bare hostname such as "example.com", a full URL, or a question naming the domain, and I will report the certificate's validity, issuer, expiry, and trust chain.`,
    );
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
  const category = classifyCertificate(result);
  const issuerName = result.issuer?.O ?? result.issuer?.CN ?? 'unknown issuer';
  const summaryByCategory = {
    valid: `${domain} has a valid certificate, expiring in ${result.daysUntilExpiry} days (issued by ${issuerName})`,
    expired: `${domain}'s certificate expired ${Math.abs(result.daysUntilExpiry)} days ago (issued by ${issuerName})`,
    self_signed: `${domain} is serving a self-signed certificate, not one from a trusted certificate authority`,
    hostname_mismatch: `${domain} is serving a certificate issued for a different hostname, so it does not match ${domain}`,
    untrusted: `${domain}'s certificate does not chain to a trusted root${result.authorizationError ? ` (${result.authorizationError})` : ''}`,
  };

  res.json({
    query: domain,
    status: 'ok',
    summary: summaryByCategory[category],
    confidence: 1.0,
    canonical: ['ssl', domain, category, result.daysUntilExpiry].join(':'),
    valid,
    category,
    authorized: result.authorized,
    authorization_error: result.authorizationError,
    chain_complete: category !== 'untrusted' && category !== 'self_signed',
    hostname_valid: category !== 'hostname_mismatch',
    issuer: issuerName,
    valid_from: result.validFrom,
    valid_to: result.validTo,
    days_until_expiry: result.daysUntilExpiry,
  });
}

// Turns Node's raw authorized/authorizationError pair into the same named
// buckets a competing SSL miner reports (valid/expired/self-signed/
// untrusted/wrong-hostname), instead of one generic "not trusted".
function classifyCertificate(result) {
  if (result.authorized && result.daysUntilExpiry > 0) return 'valid';
  if (result.daysUntilExpiry <= 0) return 'expired';
  const err = String(result.authorizationError ?? '');
  if (/SELF_SIGNED/.test(err)) return 'self_signed';
  if (/ALTNAME|altnames|Hostname\/IP/.test(err)) return 'hostname_mismatch';
  return 'untrusted';
}

router.get('/', (req, res) => withRpcBudget(() => handleSslVerification(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleSslVerification(req, res)));

export default router;
