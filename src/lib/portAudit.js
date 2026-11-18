// Passive port audit. Nothing is sent to the audited host: the host name is
// resolved through DNS and the address is looked up in Shodan InternetDB
// (internetdb.shodan.io, free, no key), the public index of Shodan's
// internet-wide scans. The only URL built is internetdb.shodan.io/<validated
// IP literal>, never one made from caller text.

import dns from 'node:dns/promises';
import net from 'node:net';
import { isPrivateIp, BLOCKED_HOSTNAME_RE } from './ssrfGuard.js';

export class PortAuditError extends Error {}

const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/i;

// Pulls the target out of a free-text question, an IPv4 address or a URL.
export function targetFromText(text) {
  const t = String(text ?? '');
  const url = t.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
  if (url) {
    try { return new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { /* fall through */ }
  }
  const ip = t.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];
  if (ip && net.isIPv4(ip)) return ip;
  const v6 = t.match(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/i)?.[0];
  if (v6 && net.isIPv6(v6)) return v6;
  const dom = t.replace(/\b[\w.+-]+@/g, '').match(DOMAIN_RE)?.[0];
  return dom ? dom.toLowerCase() : null;
}

export const RISKY_PORTS = new Map([
  [21, 'FTP'], [23, 'Telnet'], [69, 'TFTP'], [110, 'POP3'], [135, 'MS-RPC'], [137, 'NetBIOS'], [139, 'NetBIOS'], [445, 'SMB'],
  [512, 'rexec'], [513, 'rlogin'], [514, 'rsh'], [1433, 'MS SQL'], [1521, 'Oracle DB'], [2049, 'NFS'], [2375, 'Docker API'],
  [3306, 'MySQL'], [3389, 'RDP'], [5432, 'PostgreSQL'], [5900, 'VNC'], [5984, 'CouchDB'], [6379, 'Redis'], [9200, 'Elasticsearch'],
  [11211, 'Memcached'], [27017, 'MongoDB'],
]);

const SERVICES = new Map([
  [22, 'SSH'], [25, 'SMTP'], [53, 'DNS'], [80, 'HTTP'], [123, 'NTP'], [143, 'IMAP'], [443, 'HTTPS'], [465, 'SMTPS'], [587, 'SMTP submission'],
  [993, 'IMAPS'], [995, 'POP3S'], [8080, 'HTTP alt'], [8443, 'HTTPS alt'], ...RISKY_PORTS,
]);

export const serviceName = (port) => SERVICES.get(port) ?? 'unknown';

export async function resolveTarget(host) {
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new PortAuditError(`${host} is a private or reserved address, which no public scan index covers`);
    return host;
  }
  if (BLOCKED_HOSTNAME_RE.test(host) || !/^[a-z0-9.-]+$/i.test(host) || host.length > 253) throw new PortAuditError(`${host} is not a public host name`);
  let records;
  try {
    records = await dns.lookup(host, { all: true, family: 4 });
  } catch {
    try { records = await dns.lookup(host, { all: true }); } catch { throw new PortAuditError(`${host} does not resolve in DNS`); }
  }
  const pub = records.find((r) => !isPrivateIp(r.address));
  if (!pub) throw new PortAuditError(`${host} resolves only to private addresses`);
  return pub.address;
}

// Returns null when Shodan holds no record for the address.
export async function fetchInternetDb(ip) {
  if (!net.isIP(ip)) throw new PortAuditError('not an IP address');
  const res = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'user-agent': 'txlens-portaudit/1.0', accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new PortAuditError(`Shodan InternetDB answered HTTP ${res.status}`);
  return res.json();
}

export function assess(data) {
  const ports = [...(data?.ports ?? [])].filter(Number.isInteger).sort((a, b) => a - b);
  const risky = ports.filter((p) => RISKY_PORTS.has(p)).map((p) => `${p}/${RISKY_PORTS.get(p)}`);
  const vulns = [...(data?.vulns ?? [])].filter((v) => /^CVE-\d{4}-\d{4,}$/.test(v));
  let level = 'low';
  if (risky.length || vulns.length >= 20) level = 'high';
  else if (vulns.length || ports.length > 5) level = 'medium';
  return {
    ports,
    services: ports.map((p) => `${p}/${serviceName(p)}`),
    risky,
    vulns,
    level,
    cpes: (data?.cpes ?? []).slice(0, 8),
    hostnames: (data?.hostnames ?? []).slice(0, 5),
    tags: data?.tags ?? [],
  };
}
