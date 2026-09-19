// DNS_RECORD_LOOKUP signal endpoint. Given a hostname, queries DNS for
// A, AAAA, CNAME, MX, TXT, NS, SOA, and SRV records using Node.js's native
// dns.promises module. No external API needed.

import { Router } from 'express';
import { promises as dns } from 'dns';
import { extractHostname, firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';

const router = Router();

// Deliberately permissive — real-world hostnames include hyphens,
// subdomains, and internationalized labels; this only rejects the obvious
// non-hostname cases (protocol prefix, path, whitespace) rather than
// re-implementing full hostname validation.
const DOMAIN_RE = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const DNS_TIMEOUT_MS = 10_000;

async function queryRecordType(hostname, type) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);

    let results;
    switch (type) {
      case 'A':
        results = await dns.resolve4(hostname);
        break;
      case 'AAAA':
        results = await dns.resolve6(hostname);
        break;
      case 'CNAME':
        results = await dns.resolveCname(hostname);
        break;
      case 'MX':
        results = await dns.resolveMx(hostname);
        break;
      case 'TXT':
        results = await dns.resolveTxt(hostname);
        break;
      case 'NS':
        results = await dns.resolveNs(hostname);
        break;
      case 'SOA':
        results = await dns.resolveSoa(hostname);
        break;
      case 'SRV':
        // SRV records require a service name; we'll skip this for bare hostnames
        return { type, records: [] };
      default:
        return { type, records: [] };
    }

    clearTimeout(timer);
    return {
      type,
      records: Array.isArray(results) ? results : (results ? [results] : []),
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { type, records: [], error: 'timeout' };
    }
    // ENOTFOUND and other DNS errors are normal when records don't exist
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') {
      return { type, records: [] };
    }
    return { type, records: [], error: err.message };
  }
}

function buildSummary(hostname, records) {
  const recordsByType = {};
  let totalRecords = 0;
  const foundTypes = [];

  for (const record of records) {
    if (record.records.length > 0) {
      recordsByType[record.type] = record.records;
      foundTypes.push(record.type);
      totalRecords += record.records.length;
    }
  }

  if (totalRecords === 0) {
    return `No DNS records found for ${hostname}. The hostname may be invalid, not delegated to any authoritative nameservers, or all requested record types are absent.`;
  }

  const recordList = foundTypes
    .map((type) => {
      const count = recordsByType[type].length;
      return `${count} ${type} record${count === 1 ? '' : 's'}`;
    })
    .join(', ');

  return `DNS records found for ${hostname}: ${recordList} total.`;
}

async function handleDnsRecords(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawHostname = firstUsableValue(
    params?.hostname,
    params?.domain,
    params?.host,
    params?.url,
    params?.query,
    params?.q,
    params?.question,
  );

  // Exact bare hostname first; if that fails, pull a hostname out of a
  // full URL, a "host:port" pair, or a whole question naming the domain,
  // rather than rejecting outright.
  const hostname = rawHostname && DOMAIN_RE.test(rawHostname) ? rawHostname : extractHostname(rawHostname);

  if (!rawHostname) {
    return respondUnusableInput(
      res,
      'I cannot query DNS records because no hostname was supplied. Pass a bare hostname such as "example.com" as the hostname parameter and I will report its A, AAAA, CNAME, MX, TXT, NS, and SOA records.',
    );
  }
  if (!hostname) {
    return respondUnusableInput(
      res,
      `I cannot query DNS records for ${quoteParam(rawHostname)} because I cannot find a hostname in it. Pass a bare hostname such as "example.com", a full URL, or a question naming the domain.`,
    );
  }

  // Query all record types in parallel
  const recordTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA'];
  const results = await Promise.all(recordTypes.map((type) => queryRecordType(hostname, type)));

  const summary = buildSummary(hostname, results);
  const recordsByType = {};

  for (const result of results) {
    if (result.records.length > 0) {
      recordsByType[result.type] = result.records;
    }
  }

  // Confidence is high when we successfully queried DNS, even if some record
  // types are not found (which is normal).
  res.json({
    query: hostname,
    status: 'ok',
    summary,
    confidence: Object.keys(recordsByType).length > 0 ? 0.95 : 0.8,
    canonical: ['dns', hostname].join(':'),
    hostname,
    records: recordsByType,
    record_types_checked: recordTypes,
    records_found: Object.keys(recordsByType).length,
    total_records: Object.values(recordsByType).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 1), 0),
    queried_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleDnsRecords(req, res));
router.post('/', (req, res) => handleDnsRecords(req, res));

export default router;
