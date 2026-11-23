// Real document checks for DOCUMENT_AUTHENTICITY, done with arithmetic and
// file reads instead of a language model's opinion:
//   1. text copies in the question: SHA-256 of each copy against the stored
//      hash (with and without a trailing newline), and what differs;
//   2. digests and hash chains written in the question: two digests that
//      should be equal, and prev_hash links that must equal the last hash;
//   3. a linked PDF: fetch it, SHA-256 of the file, the embedded signature
//      (signer, signing time, bytes covered, whether the signed digest and
//      the signature itself check out), and, for Federal Register links, the
//      title, agency and date the public index lists.
// What cannot be checked here (whether the signer's certificate chains to a
// trusted root, revocation, the author's identity) is always said so.

import crypto from 'node:crypto';
import { parsePublicUrl, assertResolvesPublic } from './ssrfGuard.js';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

class FetchError extends Error {}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

// ---- 1. copies of a text -----------------------------------------------------

export function inlineBlocks(text) {
  return [...String(text ?? '').matchAll(/<<<\s*([\s\S]*?)\s*>>>/g)].map((m) => m[1]);
}

export function hex64s(text) {
  return [...String(text ?? '').matchAll(/(?<![0-9a-fA-F])([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)].map((m) => m[1].toLowerCase());
}

function differences(a, b) {
  const wa = a.split(/\s+/);
  const wb = b.split(/\s+/);
  let i = 0;
  while (i < wa.length && i < wb.length && wa[i] === wb[i]) i += 1;
  let j = 0;
  while (j < wa.length - i && j < wb.length - i && wa[wa.length - 1 - j] === wb[wb.length - 1 - j]) j += 1;
  const left = wa.slice(Math.max(0, i - 2), wa.length - j).join(' ');
  const right = wb.slice(Math.max(0, i - 2), wb.length - j).join(' ');
  return left === right ? null : { first: left, second: right };
}

export function compareCopies(text) {
  const blocks = inlineBlocks(text);
  const stated = hex64s(text);
  if (!blocks.length || !stated.length) return null;
  const wantsNewline = /(?:add|append|include|with)\s+(?:that\s+|the\s+|a\s+)?(?:final|trailing|last)\s+newline|bytes end with one newline|remember to add it/i.test(text);
  const noNewline = /without a trailing newline|no trailing newline|without (?:the )?final newline/i.test(text);
  const variants = noNewline ? [['without a trailing newline', (s) => s]]
    : wantsNewline ? [['with one trailing newline', (s) => `${s}\n`]]
      : [['as written, no trailing newline', (s) => s], ['with one trailing newline', (s) => `${s}\n`]];
  const rows = blocks.map((b, i) => {
    const hashes = variants.map(([label, f]) => ({ label, hash: sha256(f(b)) }));
    let hit = hashes.find((h) => stated.includes(h.hash));
    let used = b;
    // Line breaks are often flattened to spaces when a question is passed on.
    // If the text as written matches nothing, try it with a line break before
    // each "Label:" field (and after a first title line) before giving up.
    if (!hit && !/\n/.test(b)) {
      const rebuilt = b.replace(/\s+(?=[A-Z][A-Za-z0-9]*(?: [a-z][a-z0-9]*){0,2}:\s)/g, '\n');
      const title = rebuilt.replace(/^([^\n:]{6,80}?)\n(?=[A-Z][A-Za-z ]{1,28}:)/, '$1\n');
      for (const cand of new Set([rebuilt, title, rebuilt.replace(/^([A-Z][A-Z0-9 -]{4,60}[A-Z0-9]) (?=[A-Z][a-z])/, '$1\n')])) {
        for (const [label, f] of variants) {
          const h = sha256(f(cand));
          if (stated.includes(h)) { hit = { label: `${label}, line breaks restored at each field`, hash: h }; used = cand; break; }
        }
        if (hit) break;
      }
    }
    return { index: i + 1, text: used, hashes, matches: hit ? { hash: hit.hash, variant: hit.label } : null };
  });
  const lines = rows.map((r) => `Copy ${r.index}: SHA-256 ${r.hashes[0].hash}${r.hashes.length > 1 ? ` (${r.hashes[0].label}), ${r.hashes[1].hash} (${r.hashes[1].label})` : ` (${r.hashes[0].label})`} ${r.matches ? `matches the stated hash ${r.matches.hash}` : 'matches none of the stated hashes'}.`);
  let diff = null;
  if (rows.length >= 2) diff = differences(rows[0].text, rows[1].text);
  const anyMatch = rows.some((r) => r.matches);
  const allMatch = rows.every((r) => r.matches);
  let authentic;
  let verdict;
  if (allMatch) { authentic = true; verdict = 'Authentic: every copy hashes to a stated value, so the bytes are unchanged since the hash was taken.'; }
  else if (anyMatch) {
    authentic = false;
    const bad = rows.filter((r) => !r.matches).map((r) => `copy ${r.index}`).join(' and ');
    verdict = `Not authentic: ${bad} does not match the stored hash, so it was changed after the hash was taken.`;
  } else { authentic = false; verdict = 'Not authentic: no copy hashes to the stated value.'; }
  // Hashes the question itself labels as stored/original and as received/current.
  const labelled = [...String(text).matchAll(/(?<![0-9a-fA-F])([0-9a-fA-F]{64})(?![0-9a-fA-F])/g)].map((m) => ({ h: m[1].toLowerCase(), ctx: text.slice(Math.max(0, m.index - 70), m.index).toLowerCase() }));
  const stored = labelled.find((l) => /stored|taken|signing|signed|issued|original|registered|recorded|expected/.test(l.ctx));
  const received = labelled.find((l) => l !== stored && /received|arrived|supplied|sent|current|presented|submitted|now/.test(l.ctx));
  let pairNote = '';
  if (stored && received) {
    pairNote = stored.h === received.h
      ? ' The stored hash and the hash of the file as received are identical, so an automated byte check passes.'
      : ` The stored hash (${stored.h}) and the hash of the file as received (${received.h}) are different, so an automated byte-for-byte check must fail; the file as received is not the byte-identical file that was hashed when it was issued, even if it looks the same on screen.`;
    if (received.h !== stored.h) { authentic = false; verdict = 'Not authentic as a byte-identical copy: the stored and received hashes differ, so the integrity check must fail.'; }
    else if (!anyMatch) { authentic = true; verdict = 'The stored and received hashes are identical, so the integrity check passes.'; }
  }
  const answer = `${verdict} ${lines.join(' ')}${diff ? ` The copies differ here: "${diff.first}" against "${diff.second}".` : ''}${pairNote} Stated hash${stated.length > 1 ? 'es' : ''}: ${stated.join(', ')}. Hashing is exact to the byte, so any changed character gives a different value.`;
  return { authentic, verdict, answer, evidence: { copies: rows.map((r) => ({ copy: r.index, sha256: r.hashes.map((h) => h.hash), matches_stated: Boolean(r.matches) })), stated_hashes: stated, differences: diff } };
}

// ---- 2. digests and hash chains written in the question -----------------------

const PLACEHOLDER = /^(?:([0-9a-f])\1+|0123456789abcdef.*|(?:a1b2c3d4)+.*|(?:deadbeef)+.*|(?:abcd)+.*)$/i;

export function digestChecks(text) {
  const findings = [];
  const hex = [...String(text ?? '').matchAll(/(?<![0-9a-fA-F])([0-9a-fA-F]{40,72})(?![0-9a-fA-F])/g)];
  // A stated SHA-256 that is not 64 characters, or an obvious placeholder.
  for (const m of hex) {
    if (m[1].length !== 64) findings.push(`The value ${m[1].slice(0, 12)}... is ${m[1].length} hex characters long, not the 64 of a SHA-256.`);
    else if (PLACEHOLDER.test(m[1])) findings.push(`The value ${m[1].slice(0, 12)}... is a placeholder pattern, not a real digest.`);
  }
  // Two digests that are supposed to be the same value but differ.
  const labelled = hex.filter((m) => m[1].length === 64).map((m) => ({ h: m[1].toLowerCase(), ctx: text.slice(Math.max(0, m.index - 90), m.index).toLowerCase() }));
  if (/payload|digest|signed/i.test(text) && labelled.length >= 2) {
    for (let i = 0; i < labelled.length; i += 1) {
      for (let j = i + 1; j < labelled.length; j += 1) {
        const a = labelled[i].h;
        const b = labelled[j].h;
        let diffs = 0;
        for (let k = 0; k < 64; k += 1) if (a[k] !== b[k]) diffs += 1;
        if (a !== b && diffs <= 12) findings.push(`Two digests that should be identical differ in ${diffs} of 64 characters (${a.slice(-8)} against ${b.slice(-8)} at the end), so the signed payload is not the document payload.`);
      }
    }
  }
  // Hash chain: event n must record prev_hash equal to event n-1's hash.
  const events = [...String(text ?? '').matchAll(/Event\s+(\d+)\b/gi)];
  if (events.length >= 2) {
    const segs = events.map((e, i) => text.slice(e.index, events[i + 1]?.index ?? text.length));
    const norm = (s) => String(s).toLowerCase().replace(/…/g, '...');
    const hashes = segs.map((s) => norm(/\bH\d+\s*=\s*([0-9a-f.]{6,64})/i.exec(s)?.[1] ?? ''));
    const prevs = segs.map((s) => norm(/prev(?:ious)?_?hash\s*=\s*([0-9a-f.]{6,64})/i.exec(s)?.[1] ?? ''));
    for (let n = 1; n < segs.length; n += 1) {
      if (!prevs[n] || !hashes[n - 1]) continue;
      if (prevs[n] === hashes[n - 1]) findings.push(`Event ${n + 1} links correctly: its prev_hash ${prevs[n]} equals Event ${n}'s hash.`);
      else findings.push(`The chain is broken at Event ${n + 1}: its prev_hash ${prevs[n]} does not equal Event ${n}'s hash ${hashes[n - 1]}, so an event was inserted, removed or altered.`);
    }
  }
  if (!findings.length) return null;
  const bad = findings.some((f) => /broken|differ|placeholder|not the 64/.test(f));
  const sigNote = /signature (?:is )?(?:cryptographically )?valid/i.test(text)
    ? ' A valid signature over a value does not prove the value belongs to this record: the signature only covers what was signed.' : '';
  const verdict = bad ? 'Not authentic: the stated digests or links are inconsistent.' : 'The stated hash links are consistent; this checks the arithmetic only.';
  return {
    authentic: !bad && null, verdict,
    answer: `${verdict} ${findings.join(' ')}${sigNote} Only the numbers written in the question were compared; the underlying files and registries were not available to read.`,
    evidence: { findings },
  };
}

// ---- 3. a linked PDF ---------------------------------------------------------

export function urlsIn(text) {
  return [...String(text ?? '').matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0].replace(/[.,;]+$/, ''));
}

async function download(url) {
  const parsed = parsePublicUrl(url, FetchError);
  await assertResolvesPublic(parsed, FetchError);
  const res = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow', headers: { 'User-Agent': 'TxLens/1.0 document check', Accept: 'application/pdf,*/*' } });
  if (!res.ok) throw new FetchError(`the server answered HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_PDF_BYTES) throw new FetchError(`the file is ${declared} bytes, over the ${MAX_PDF_BYTES} byte limit`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new FetchError('the file is over the size limit');
  return buf;
}

// Minimal DER reader: enough to open a CMS (PKCS#7) signature.
function tlv(buf, off) {
  const tag = buf[off];
  let len = buf[off + 1];
  let hdr = 2;
  if (len === 0x80) {
    // Indefinite length (BER): the content runs until a 00 00 marker.
    let o = off + 2;
    while (!(buf[o] === 0 && buf[o + 1] === 0) && o < buf.length) o = tlv(buf, o).fullEnd;
    return { tag, hdr: 2, len: o - off - 2, start: off + 2, end: o, off, fullEnd: o + 2 };
  }
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i += 1) len = (len * 256) + buf[off + 2 + i];
    hdr = 2 + n;
  }
  return { tag, hdr, len, start: off + hdr, end: off + hdr + len, off, fullEnd: off + hdr + len };
}
function children(buf, node) {
  const out = [];
  let o = node.start;
  while (o < node.end) { const c = tlv(buf, o); out.push(c); o = c.fullEnd; }
  return out;
}
const oidOf = (buf, node) => {
  const b = buf.subarray(node.start, node.end);
  const parts = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i += 1) { v = (v * 128) + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
};
const HASHES = { '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512' };

function parseTime(buf, node) {
  const s = buf.subarray(node.start, node.end).toString('latin1');
  const m = node.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s);
  if (!m) return null;
  const year = node.tag === 0x17 ? (Number(m[1]) >= 50 ? 1900 + Number(m[1]) : 2000 + Number(m[1])) : Number(m[1]);
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))).toISOString();
}

export function inspectCms(der, signedBytes) {
  const out = { parsed: false };
  try {
    const root = tlv(der, 0);
    const content0 = children(der, root)[1]; // [0] EXPLICIT SignedData
    const signedData = children(der, content0)[0];
    const sd = children(der, signedData);
    const certsNode = sd.find((n) => n.tag === 0xa0);
    const signerInfos = sd[sd.length - 1];
    const si = children(der, children(der, signerInfos)[0]);
    const digestAlgOid = oidOf(der, children(der, si[2])[0]);
    const hashName = HASHES[digestAlgOid] ?? null;
    const attrsNode = si.find((n) => n.tag === 0xa0);
    const sigNode = si.filter((n) => n.tag === 0x04).at(-1);
    const certs = [];
    if (certsNode) {
      for (const c of children(der, certsNode)) {
        try { certs.push(new crypto.X509Certificate(der.subarray(c.off, c.fullEnd))); } catch { /* skip an unreadable certificate */ }
      }
    }
    let messageDigest = null;
    let signingTime = null;
    if (attrsNode) {
      for (const attr of children(der, attrsNode)) {
        const parts = children(der, attr);
        const oid = oidOf(der, parts[0]);
        const val = children(der, parts[1])[0];
        if (oid === '1.2.840.113549.1.9.4') messageDigest = der.subarray(val.start, val.end).toString('hex');
        if (oid === '1.2.840.113549.1.9.5') signingTime = parseTime(der, val);
      }
    }
    out.parsed = true;
    out.hashName = hashName;
    out.messageDigest = messageDigest;
    out.signingTime = signingTime;
    out.calculatedDigest = hashName ? crypto.createHash(hashName).update(signedBytes).digest('hex') : null;
    out.digestMatches = Boolean(messageDigest && out.calculatedDigest && messageDigest === out.calculatedDigest);
    // Which certificate signed: the one whose key verifies the signature.
    out.signatureValid = null;
    if (attrsNode && sigNode && hashName) {
      const attrs = Buffer.from(der.subarray(attrsNode.off, attrsNode.end));
      attrs[0] = 0x31; // signed attributes are signed as a SET
      const signature = der.subarray(sigNode.start, sigNode.end);
      for (const cert of certs) {
        try {
          if (crypto.verify(hashName, attrs, cert.publicKey, signature)) {
            out.signatureValid = true;
            out.signer = cert;
            break;
          }
        } catch { /* wrong key type: try the next certificate */ }
      }
      if (!out.signer) out.signatureValid = false;
    }
    out.certCount = certs.length;
    const cn = (c) => /CN=([^\n]+)/.exec(c.subject)?.[1] ?? c.subject.replace(/\n/g, ', ');
    out.signerName = out.signer ? cn(out.signer) : null;
    out.signerIssuer = out.signer ? cn({ subject: out.signer.issuer }) : null;
    out.signerValidTo = out.signer?.validTo ?? null;
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

export function inspectPdf(buf) {
  const text = buf.toString('latin1');
  const info = { bytes: buf.length, sha256: sha256(buf), isPdf: text.startsWith('%PDF-') };
  const br = [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)];
  info.signatures = br.length;
  if (br.length) {
    const [a, b, c, d] = br.at(-1).slice(1).map(Number);
    const gap = buf.subarray(b, c).toString('latin1');
    const hex = /<([0-9a-fA-F\s]+)>/.exec(gap)?.[1]?.replace(/\s+/g, '') ?? '';
    const der = Buffer.from(hex, 'hex');
    const signed = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);
    info.signed_content_bytes = signed.length;
    info.covers_whole_file = c + d === buf.length;
    info.cms = inspectCms(der, signed);
    const name = /\/Name\s*\(([^)]{2,100})\)/.exec(text.slice(Math.max(0, b - 3000), b + 20));
    info.sig_dict_name = name?.[1] ?? null;
  }
  const xmp = /<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]+)<\/rdf:li>/.exec(text)?.[1];
  const infoTitle = [...text.matchAll(/\/Title\s*\(([^)]{3,200})\)/g)].map((m) => m[1]).find((t) => !/^Layer/i.test(t));
  info.pdf_title = (xmp ?? infoTitle ?? null)?.trim() ?? null;
  return info;
}

async function federalRegisterRecord(url) {
  const m = /FR-(\d{4}-\d{2}-\d{2})\/(?:pdf\/|html\/)?([0-9]{4}-[0-9]{4,6})/.exec(url) ?? /\/(\d{4}-\d{4,6})\.pdf/.exec(url);
  const doc = m?.[2] ?? m?.[1];
  if (!doc || !/^\d{4}-\d{4,6}$/.test(doc)) return null;
  try {
    const res = await fetch(`https://www.federalregister.gov/api/v1/documents/${doc}.json?fields[]=title&fields[]=agency_names&fields[]=publication_date&fields[]=document_number&fields[]=pdf_url&fields[]=type`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function checkLinkedPdf(text) {
  const url = urlsIn(text).find((u) => /\.pdf(?:$|[?#])/i.test(u) || /govinfo|federalregister|archive\.org/i.test(u));
  if (!url) return null;
  let buf;
  try {
    buf = await download(url);
  } catch (err) {
    const why = `The linked file could not be fetched (${err.message}), so no hash or signature was checked. Nothing about its authenticity is stated.`;
    return { authentic: null, verdict: 'Inconclusive: the file could not be fetched.', answer: why, evidence: { url, fetched: false, error: err.message } };
  }
  const info = inspectPdf(buf);
  if (!info.isPdf) {
    const why = `The linked file is not a PDF (it does not start with the PDF header), so no signature could be read. Its SHA-256 is ${info.sha256} (${info.bytes} bytes).`;
    return { authentic: null, verdict: 'Inconclusive: not a PDF.', answer: why, evidence: { url, sha256: info.sha256, bytes: info.bytes } };
  }
  const index = await federalRegisterRecord(url);
  const stated = hex64s(text);
  const parts = [];
  const problems = [];
  parts.push(`File SHA-256 ${info.sha256} (${info.bytes} bytes).`);
  if (stated.length) {
    if (stated.includes(info.sha256)) parts.push('It matches the hash given in the question.');
    else { problems.push('hash mismatch'); parts.push(`It does NOT match the hash given in the question (${stated[0]}).`); }
  }
  const cms = info.cms;
  if (info.signatures && cms?.parsed) {
    parts.push(`The PDF carries ${info.signatures} embedded signature${info.signatures > 1 ? 's' : ''}. CMS signer: ${cms.signerName ?? 'not identified from the embedded certificates'}${cms.signerIssuer ? ` (issued by ${cms.signerIssuer})` : ''}; signing_time ${cms.signingTime ?? 'not recorded in the signature'}; signed_content_bytes ${info.signed_content_bytes} of ${info.bytes}${info.covers_whole_file ? ' (the signature covers the whole file, nothing was added after signing)' : ' (bytes after the signed range exist, so the file was extended after signing)'}.`);
    parts.push(`The digest inside the signature ${cms.digestMatches ? 'equals' : 'does NOT equal'} the ${cms.hashName ?? ''} of the signed bytes${cms.digestMatches ? ', so the signed content is unchanged' : ', so the signed content was altered'}; the signature itself ${cms.signatureValid === true ? 'verifies against the signer certificate key' : cms.signatureValid === false ? 'does NOT verify against any embedded certificate' : 'could not be verified'}.`);
    if (!cms.digestMatches) problems.push('signed digest mismatch');
    if (cms.signatureValid === false) problems.push('signature invalid');
    if (!info.covers_whole_file) problems.push('bytes after the signed range');
  } else if (info.signatures) {
    parts.push(`The PDF has a signature field but its signature data could not be read (${cms?.error ?? 'unknown format'}).`);
  } else {
    parts.push('The PDF has no embedded digital signature, so only its hash can be stated.');
  }
  if (info.pdf_title) parts.push(`PDF title: ${info.pdf_title}.`);
  if (index) {
    parts.push(`The Federal Register index lists document ${index.document_number} as "${index.title}", published ${index.publication_date}, agency ${index.agency_names?.join(', ')}.`);
    const askedDate = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(String(text).replace(/web\.archive\.org\/web\/\d+/g, ''))?.[1];
    if (askedDate && askedDate !== index.publication_date && /publication date|published/i.test(text)) { problems.push('date mismatch'); parts.push(`The question gives ${askedDate}, which does not match the index date.`); }
    const claimed = /lists\s+([A-Z][^.]{3,120}?)\s+for this record/.exec(text)?.[1] ?? /Agency metadata:\s*([^.]{3,120})\./.exec(text)?.[1];
    if (claimed) {
      const ok = (index.agency_names ?? []).some((n) => n.toLowerCase().includes(claimed.trim().toLowerCase()) || claimed.trim().toLowerCase().includes(n.toLowerCase()));
      if (!ok) { problems.push('agency mismatch'); parts.push(`The question names ${claimed.trim()} but the index lists ${index.agency_names?.join(', ')}.`); }
      else parts.push(`The agency named in the question (${claimed.trim()}) matches the index.`);
    }
  }
  parts.push('Not checked: whether the signer certificate chains to a trusted root, whether it has been revoked, and who actually wrote the document. A valid signature proves the bytes are unchanged since signing, not that the content is accurate.');
  const verified = info.signatures && cms?.parsed && cms.digestMatches && cms.signatureValid === true;
  const authentic = problems.length ? false : verified ? true : null;
  const verdict = problems.length ? `Not authentic: ${problems.join(', ')}.`
    : verified ? 'Authentic at the file level: the file is byte-for-byte what was signed, and the signature verifies. Trust of the signer certificate and revocation were not checked.'
      : 'Inconclusive: no verifiable signature was found, only the file hash is stated.';
  return {
    authentic, verdict, answer: `${verdict} ${parts.join(' ')}`,
    evidence: {
      document: url, title: index?.title ?? info.pdf_title, sha256: info.sha256, bytes: info.bytes,
      cms_signer: cms?.signerName ?? null, signing_time: cms?.signingTime ?? null, signed_content_bytes: info.signed_content_bytes ?? null,
      signed_digest_matches: cms?.digestMatches ?? null, signature_valid: cms?.signatureValid ?? null,
      covers_whole_file: info.covers_whole_file ?? null, publication_date: index?.publication_date ?? null, agency: index?.agency_names ?? null,
      trust_chain_checked: false, revocation_checked: false,
    },
  };
}

// ---- entry ---------------------------------------------------------------------

export async function checkDocument(text) {
  const t = String(text ?? '');
  const copies = compareCopies(t);
  if (copies) return copies;
  const pdf = await checkLinkedPdf(t).catch(() => null);
  if (pdf) return pdf;
  return digestChecks(t);
}
