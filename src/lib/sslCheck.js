// SSL_VERIFICATION signal — checks a domain's TLS certificate directly via
// Node's built-in `tls` module (a real TLS handshake to the domain on port
// 443). No external API, no key, no rate limit but our own — the signal is
// exactly as fresh as the certificate the server is presenting right now.
// Live-checked 2026-08-25 against google.com.

import tls from 'node:tls';

const CALL_TIMEOUT_MS = Number(process.env.SSL_CHECK_TIMEOUT_MS) || 6_000;

export class SslConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SslConnectionError';
  }
}

// subjectaltname arrives as "DNS:a.example.com, DNS:*.example.com,
// IP Address:1.2.3.4" — one flat string. Only the DNS and IP entries are
// names a request can match on.
function parseAltNames(subjectAltName) {
  if (typeof subjectAltName !== 'string') return [];
  return subjectAltName
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^(?:DNS|IP Address):/i.test(entry))
    .map((entry) => entry.replace(/^(?:DNS|IP Address):\s*/i, ''));
}

// Wildcard matching as the TLS rules define it: "*" covers exactly one
// label, so *.example.com matches a.example.com but not a.b.example.com.
function hostMatches(host, name) {
  const h = host.toLowerCase();
  const n = name.toLowerCase();
  if (h === n) return true;
  if (!n.startsWith('*.')) return false;
  const suffix = n.slice(1);
  return h.endsWith(suffix) && !h.slice(0, h.length - suffix.length).includes('.');
}

// Walks issuerCertificate up the chain and counts what the SERVER sent.
//
// Node terminates the chain with the self-signed trust anchor it found in
// its own store, which the server did not necessarily transmit: google.com
// walks as leaf, WR2, GTS Root R1, GlobalSign Root CA, where only the
// first three came down the wire. Counting all four would overstate what
// the host is actually configured to serve, which is the whole point of
// checking the deployed chain rather than a transparency log. So a
// terminal self-issued certificate is excluded. The fingerprint guard
// stops a malformed chain from looping forever.
function countChain(leaf) {
  const seen = new Set();
  let node = leaf;
  let count = 0;
  while (node && count < 10) {
    const id = node.fingerprint256 ?? node.serialNumber ?? String(count);
    if (seen.has(id)) break;
    seen.add(id);
    if (node.issuerCertificate === node) {
      // A self-signed leaf is genuinely the one certificate served.
      return Math.max(count, 1);
    }
    count += 1;
    node = node.issuerCertificate;
  }
  return Math.max(count, 1);
}

// Returns { valid, authorized, authorizationError, issuer, subject,
// validFrom, validTo, daysUntilExpiry } for a domain, or throws
// SslConnectionError if the TLS handshake itself can't complete (domain
// doesn't resolve, port 443 closed, connection timeout).
export function checkSslCertificate(domain) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tls.connect(
      443,
      domain,
      // rejectUnauthorized: false — without this, Node aborts the
      // handshake with a generic 'error' event on any cert problem
      // (self-signed, expired, wrong hostname), so we could never tell
      // those apart from the domain simply being unreachable. With it
      // false, the handshake still completes and socket.authorized /
      // socket.authorizationError report exactly what's wrong. The
      // connection is never used for anything but inspection.
      { servername: domain, timeout: CALL_TIMEOUT_MS, rejectUnauthorized: false },
      () => {
        if (settled) return;
        settled = true;
        // `true` returns the full presented chain via issuerCertificate,
        // so we can report how many certificates the server actually sent
        // and whether the intermediates are there. A server that omits its
        // intermediate still validates in browsers that cache it and fails
        // elsewhere, which is exactly the intermittent breakage callers ask
        // about, and a leaf-only check cannot see it.
        const cert = socket.getPeerCertificate(true);
        // Neither of the two top-ranked competing SSL miners report the
        // actually-negotiated protocol/cipher live — we already have the
        // handshake open, so this costs nothing extra. TLS 1.0/1.1 are
        // deprecated (disabled by most modern clients); flagging that is a
        // real signal a cert-only check misses entirely.
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher();
        socket.end();

        if (!cert || Object.keys(cert).length === 0) {
          reject(new SslConnectionError(`no certificate presented by '${domain}'`));
          return;
        }

        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const daysUntilExpiry = Math.floor((validTo.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

        const altNames = parseAltNames(cert.subjectaltname);

        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorized ? null : (socket.authorizationError ?? null),
          issuer: cert.issuer ?? null,
          subject: cert.subject ?? null,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysUntilExpiry,
          protocol,
          cipherName: cipher?.name ?? null,
          protocolDeprecated: protocol === 'TLSv1' || protocol === 'TLSv1.1',
          chainLength: countChain(cert),
          altNames,
          // Which name on the certificate the request actually matched.
          // A competing miner lists every SAN, which on a large site runs
          // to fifty entries of noise; the one that matched is the answer.
          matchedAltName: altNames.find((name) => hostMatches(domain, name)) ?? null,
          keyBits: cert.bits ?? null,
          serialNumber: cert.serialNumber ?? null,
          fingerprint256: cert.fingerprint256 ?? null,
        });
      }
    );

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new SslConnectionError(`TLS connection to '${domain}' failed: ${err.message}`));
    });

    socket.on('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new SslConnectionError(`TLS connection to '${domain}' timed out after ${CALL_TIMEOUT_MS}ms`));
    });
  });
}
