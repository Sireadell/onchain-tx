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
  const rawDomain = params?.domain ?? params?.host ?? params?.url ?? params?.query ?? params?.q ?? params?.question;
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
  const chainComplete = category !== 'untrusted' && category !== 'self_signed';
  const hostnameValid = category !== 'hostname_mismatch';
  const expiryDate = result.validTo.slice(0, 10);

  // The verdict first, then one labelled clause per thing that was
  // actually checked. This is the shape the miner leading this intent
  // answers in, and it is the right shape: a caller asking "is the
  // certificate valid" wants the reasons, not a single adjective.
  const verdictByCategory = {
    valid: `The TLS/SSL certificate configuration for ${domain} is valid.`,
    expired: `The TLS/SSL certificate for ${domain} is expired and not valid.`,
    self_signed: `The TLS/SSL certificate for ${domain} is self-signed and not valid for public use.`,
    hostname_mismatch: `The TLS/SSL certificate served by ${domain} was issued for a different hostname and does not validate for ${domain}.`,
    untrusted: `The TLS/SSL certificate for ${domain} does not chain to a trusted root and is not valid.`,
  };

  const validityClause = result.daysUntilExpiry > 0
    ? `Certificate validity: currently valid, expiring in ${result.daysUntilExpiry} days on ${expiryDate}, issued by ${issuerName} on ${result.validFrom.slice(0, 10)}.`
    : `Certificate validity: expired ${Math.abs(result.daysUntilExpiry)} days ago, on ${expiryDate}, issued by ${issuerName}.`;

  const chainClause = chainComplete
    ? `Chain trust: the server presented a chain of ${result.chainLength} certificate(s) including intermediates, building a trusted path to a root in the public trust store.`
    : `Chain trust: the chain of ${result.chainLength} certificate(s) presented does not reach a trusted root${result.authorizationError ? ` (${result.authorizationError})` : ''}.`;

  const hostnameClause = hostnameValid
    ? `Hostname verification: passes${result.matchedAltName ? `, matching ${result.matchedAltName} on the certificate` : ''}${result.altNames.length > 1 ? ` out of ${result.altNames.length} names it covers` : ''}.`
    : `Hostname verification: fails — the certificate covers ${result.altNames.slice(0, 5).join(', ') || 'other names'}${result.altNames.length > 5 ? ` and ${result.altNames.length - 5} more` : ''}, none of which is ${domain}.`;

  const protocolClause = result.protocolDeprecated
    ? `Connection: negotiated over ${result.protocol} using ${result.cipherName}. ${result.protocol} is deprecated and most modern clients now refuse it, so this host will fail for many callers regardless of the certificate.`
    : `Connection: negotiated over ${result.protocol} using ${result.cipherName}${result.keyBits ? `, with a ${result.keyBits}-bit key` : ''}.`;

  const summary = [
    verdictByCategory[category],
    validityClause,
    chainClause,
    hostnameClause,
    protocolClause,
    'Read from a real TLS handshake performed against the host at request time, so this is the certificate it is serving right now, not what certificate transparency logs say was issued.',
  ].join(' ');

  res.json({
    query: domain,
    status: 'ok',
    summary,
    confidence: 1.0,
    canonical: ['ssl', domain, category, result.daysUntilExpiry].join(':'),
    valid,
    category,
    authorized: result.authorized,
    authorization_error: result.authorizationError,
    chain_complete: chainComplete,
    chain_length: result.chainLength,
    hostname_valid: hostnameValid,
    matched_hostname: result.matchedAltName,
    covers_hostnames: result.altNames,
    protocol: result.protocol,
    cipher: result.cipherName,
    protocol_deprecated: result.protocolDeprecated,
    key_bits: result.keyBits,
    serial_number: result.serialNumber,
    fingerprint_sha256: result.fingerprint256,
    issuer: issuerName,
    valid_from: result.validFrom,
    valid_to: result.validTo,
    days_until_expiry: result.daysUntilExpiry,
    checked_at: new Date().toISOString(),
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
