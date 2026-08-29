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
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || Object.keys(cert).length === 0) {
          reject(new SslConnectionError(`no certificate presented by '${domain}'`));
          return;
        }

        const validTo = new Date(cert.valid_to);
        const validFrom = new Date(cert.valid_from);
        const daysUntilExpiry = Math.floor((validTo.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorized ? null : (socket.authorizationError ?? null),
          issuer: cert.issuer ?? null,
          subject: cert.subject ?? null,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysUntilExpiry,
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
