// EMAIL_SECURITY signal endpoint: how well a domain is protected against
// email spoofing, read from its live DNS. Checks MX (can it receive mail),
// SPF (which servers may send as it), DMARC (what receivers do with mail
// that fails), DKIM at common selectors, and MTA-STS. The competing miners
// on this intent each return one raw DNS answer for a fixed domain
// (gmail.com MX, _dmarc.gmail.com TXT); this answers for the domain asked
// about, with every record read in one pass and a plain grade.

import { Router } from 'express';
import { extractHostname, firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';

const router = Router();

const DNS_TIMEOUT_MS = 6_000;
const DKIM_SELECTORS = ['google', '20230601', '20210112', 'selector1', 'selector2', 'default', 'k1', 's1', 'dkim'];

// DNS over HTTPS (Google first, Cloudflare second) rather than the host's
// own resolver: it answers the same records from anywhere, and a machine
// whose local DNS port is blocked (as on the dev laptop, 2026-09-25) would
// otherwise fail every lookup.
const DOH = [
  (name, type) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  (name, type) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
];
const TYPE_CODES = { TXT: 16, MX: 15 };

async function doh(name, type) {
  let lastErr;
  for (const url of DOH) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
    try {
      const res = await fetch(url(name, type), { headers: { accept: 'application/dns-json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
      const body = await res.json();
      // 0 = answer, 3 = name does not exist; anything else is a server failure.
      if (body.Status !== 0 && body.Status !== 3) throw new Error(`DoH status ${body.Status}`);
      return (body.Answer ?? []).filter((a) => a.type === TYPE_CODES[type]).map((a) => a.data);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// TXT data arrives quoted and sometimes split into several quoted chunks.
export function unquoteTxt(data) {
  const chunks = String(data).match(/"((?:[^"\\]|\\.)*)"/g);
  return chunks ? chunks.map((c) => c.slice(1, -1).replace(/\\"/g, '"')).join('') : String(data);
}

async function txt(name) {
  return (await doh(name, 'TXT')).map(unquoteTxt);
}

async function mx(name) {
  return (await doh(name, 'MX'))
    .map((d) => { const [p, host] = String(d).split(/\s+/); return { priority: Number(p), exchange: String(host ?? '').replace(/\.$/, '') }; })
    .filter((m) => m.exchange)
    .sort((a, b) => a.priority - b.priority);
}

// A DKIM record with an empty p= is a revoked key, not a working one
// (example.com publishes exactly that at every selector).
export function hasDkimKey(record) {
  const key = String(record).match(/(?:^|;)\s*p\s*=\s*([^;]*)/i)?.[1]?.trim();
  return Boolean(key);
}

export function parseSpf(records) {
  const spf = records.find((r) => /^v=spf1\b/i.test(r)) ?? null;
  if (!spf) return { record: null, all: null };
  const all = spf.match(/([~+?-])all\b/i)?.[1] ?? null;
  return { record: spf, all, count: records.filter((r) => /^v=spf1\b/i.test(r)).length };
}

export function parseDmarc(records) {
  const rec = records.find((r) => /^v=DMARC1\b/i.test(r)) ?? null;
  if (!rec) return { record: null, policy: null };
  const tag = (k) => rec.match(new RegExp(`(?:^|;)\\s*${k}\\s*=\\s*([^;]+)`, 'i'))?.[1]?.trim() ?? null;
  return { record: rec, policy: tag('p')?.toLowerCase() ?? null, subdomain_policy: tag('sp'), pct: tag('pct'), rua: tag('rua') };
}

const SPF_ALL_WORDS = { '-': 'hard fail (-all)', '~': 'soft fail (~all)', '?': 'neutral (?all)', '+': 'pass all (+all), which lets anyone send' };

export function gradeEmail({ mxRecords, spf, dmarc, dkim }) {
  const issues = [];
  if (!spf.record) issues.push('no SPF record');
  else if (spf.count > 1) issues.push('more than one SPF record, which makes SPF fail');
  else if (spf.all === '+' || spf.all === '?' || !spf.all) issues.push(`SPF ends in ${spf.all ? SPF_ALL_WORDS[spf.all] : 'no all rule'}`);
  if (!dmarc.record) issues.push('no DMARC record');
  else if (dmarc.policy === 'none') issues.push('DMARC policy is p=none, so spoofed mail is only reported, not blocked');
  if (!dkim.length) issues.push('no DKIM key found at the common selectors');
  const enforced = dmarc.policy === 'reject' || dmarc.policy === 'quarantine';
  let grade;
  if (spf.record && enforced && (spf.all === '-' || spf.all === '~')) grade = dmarc.policy === 'reject' ? 'Strong' : 'Good';
  else if (spf.record || dmarc.record) grade = 'Weak';
  else grade = 'Unprotected';
  if (!mxRecords.length && grade !== 'Unprotected') issues.push('no MX record, so the domain does not receive mail');
  return { grade, issues };
}

async function handleEmailSecurity(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const raw = firstUsableValue(params.domain, params.email, params.name, params.host, params.hostname, params.url, params.target) ?? freeTextParam(params);
  const emailDomain = String(raw ?? '').match(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/)?.[1];
  let domain = raw ? extractHostname(emailDomain ?? String(raw)) : null;
  if (domain) domain = domain.toLowerCase().replace(/^_dmarc\./, '').replace(/^_domainkey\./, '');

  if (!domain) {
    return respondUnusableInput(res, raw
      ? `I found no domain in ${quoteParam(raw)}. Pass domain as a bare domain such as example.com, or an email address.`
      : 'I cannot check email security because no domain was supplied. Pass domain as a bare domain such as example.com.');
  }

  let mxRecords; let rootTxt; let dmarcTxt; let dkimHits; let stsTxt;
  try {
    [mxRecords, rootTxt, dmarcTxt, stsTxt, dkimHits] = await Promise.all([
      mx(domain),
      txt(domain),
      txt(`_dmarc.${domain}`),
      txt(`_mta-sts.${domain}`),
      Promise.all(DKIM_SELECTORS.map(async (s) => ((await txt(`${s}._domainkey.${domain}`)).some(hasDkimKey) ? s : null))),
    ]);
  } catch (err) {
    return res.status(502).json({ status: 'error', summary: `DNS lookups for ${domain} did not complete. Retry shortly.`, confidence: 0, error: err.message });
  }

  let spf = parseSpf(rootTxt);
  // gmail.com's SPF is "v=spf1 redirect=_spf.google.com": the policy, and
  // its all rule, live at the redirect target. Follow one level of it.
  const redirect = spf.record && !spf.all ? spf.record.match(/\bredirect=([^\s]+)/i)?.[1] : null;
  if (redirect) {
    const target = parseSpf(await txt(redirect).catch(() => []));
    if (target.all) spf = { ...spf, all: target.all, redirect };
  }
  const dmarc = parseDmarc(dmarcTxt);
  const dkim = dkimHits.filter(Boolean);
  const mtaSts = stsTxt.some((r) => /^v=STSv1/i.test(r));
  const { grade, issues } = gradeEmail({ mxRecords, spf, dmarc, dkim });

  const parts = [
    `Email security for ${domain} is ${grade}.`,
    spf.record ? `SPF is published and ends in ${spf.all ? SPF_ALL_WORDS[spf.all] : 'no all rule'}${spf.redirect ? ` through its redirect to ${spf.redirect}` : ''} ("${spf.record.slice(0, 160)}").` : 'No SPF record is published.',
    dmarc.record ? `DMARC is published with policy p=${dmarc.policy ?? 'missing'}${dmarc.pct ? ` at pct=${dmarc.pct}` : ''}${dmarc.rua ? ', with aggregate reports enabled' : ''}.` : 'No DMARC record is published at _dmarc.' + domain + '.',
    dkim.length ? `DKIM keys found at selector(s) ${dkim.join(', ')}.` : 'No DKIM key was found at the common selectors checked (other selectors may exist).',
    mxRecords.length ? `Mail is received by ${mxRecords.slice(0, 3).map((m) => m.exchange).join(', ')}.` : 'No MX record is published.',
    mtaSts ? 'MTA-STS is enabled.' : '',
    issues.length ? `Gaps: ${issues.join('; ')}.` : 'No gaps found in SPF, DMARC or DKIM.',
  ].filter(Boolean);

  res.json({
    status: 'ok',
    summary: parts.join(' '),
    confidence: 0.9,
    canonical: ['email-security', domain, grade.toLowerCase()].join(':'),
    domain,
    grade,
    spf: spf.record,
    spf_all: spf.all,
    dmarc: dmarc.record,
    dmarc_policy: dmarc.policy,
    dkim_selectors: dkim,
    mx: mxRecords.map((m) => ({ priority: m.priority, exchange: m.exchange })),
    mta_sts: mtaSts,
    issues,
    source: 'live DNS (MX, TXT, _dmarc, _domainkey, _mta-sts)',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleEmailSecurity(req, res));
router.post('/', (req, res) => handleEmailSecurity(req, res));

export default router;
