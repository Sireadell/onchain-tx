// PORT_SCAN_AUDIT_GENERAL signal endpoint. Passive only: the host is resolved
// in DNS and looked up in Shodan InternetDB. No packet is ever sent to the
// audited host, so the answer is Shodan's last observation, not a live scan.

import { Router } from 'express';
import { firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import {
  targetFromText, resolveTarget, fetchInternetDb, assess, PortAuditError,
} from '../lib/portAudit.js';

const router = Router();
const now = () => new Date().toISOString();

async function handler(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const raw = firstUsableValue(params.host, params.target, params.ip, params.domain, params.url, params.query, params.q, params.question, params.input);
  const target = raw ? targetFromText(raw) : null;
  if (!target) {
    return respondUnusableInput(res, `No host to audit was found${raw ? ` in ${quoteParam(raw)}` : ''}. Pass a public IPv4 address, domain or URL as the host or query parameter, for example "Which ports are open on scanme.nmap.org?".`);
  }
  try {
    const ip = await resolveTarget(target);
    const data = await fetchInternetDb(ip);
    const checkedAt = now();
    const label = target === ip ? ip : `${target} (${ip})`;
    if (!data) {
      const summary = `No open ports are recorded for ${label} in Shodan InternetDB, the public index of Shodan's internet-wide scans. That means Shodan has not seen a listening service there; it does not prove that none exist. Passive data, refreshed about weekly; no connection was made to the host. Checked ${checkedAt}.`;
      return res.json({
        status: 'ok', verdict: 'not_found', summary, answer: summary, confidence: 0.6, host: target, ip, open_ports: [], services: [], risky_ports: [], risk_level: 'unknown', vulns_count: 0, vulns: [], source: 'Shodan InternetDB (passive scan index)', checked_at: checkedAt,
      });
    }
    const a = assess(data);
    const parts = [];
    parts.push(a.ports.length
      ? `${label} has ${a.ports.length} open port${a.ports.length === 1 ? '' : 's'} in Shodan's index: ${a.services.join(', ')}.`
      : `${label} has no open ports in Shodan's index.`);
    if (a.risky.length) parts.push(`Risky services exposed to the internet: ${a.risky.join(', ')}.`);
    if (a.vulns.length) parts.push(`Its software fingerprints match ${a.vulns.length} known CVEs (for example ${a.vulns.slice(0, 3).join(', ')}).`);
    parts.push(`Risk level: ${a.level}.`);
    parts.push(`Source: Shodan InternetDB, a passive index refreshed about weekly, so it shows what Shodan last observed rather than this moment; CVE matches come from version fingerprints and are not confirmed exploitable. No connection was made to the host. Checked ${checkedAt}.`);
    const summary = parts.join(' ');
    return res.json({
      status: 'ok',
      verdict: 'found',
      summary,
      answer: summary,
      confidence: 0.7,
      host: target,
      ip,
      open_ports: a.ports,
      services: a.services,
      risky_ports: a.risky,
      risk_level: a.level,
      vulns_count: a.vulns.length,
      vulns: a.vulns.slice(0, 15),
      software: a.cpes,
      hostnames: a.hostnames,
      tags: a.tags,
      source: 'Shodan InternetDB (passive scan index)',
      checked_at: checkedAt,
    });
  } catch (err) {
    if (err instanceof PortAuditError && /does not resolve|not a public|private/.test(err.message)) {
      return respondUnusableInput(res, `${err.message}, so there is nothing to look up in the passive scan index.`);
    }
    const summary = `The Shodan InternetDB lookup for ${quoteParam(target)} did not answer at request time (${err.message}), so no ports or CVEs are stated rather than guessed. Checked ${now()}.`;
    return res.json({ status: 'unavailable', verdict: 'unavailable', summary, answer: summary, confidence: 0.2, host: target, checked_at: now() });
  }
}

router.get('/', handler);
router.post('/', handler);

export default router;
