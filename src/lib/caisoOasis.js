// CAISO OASIS: the California grid operator's own public price service, no
// key. Day-ahead hourly LMP (PRC_LMP) and real-time 5-minute LMP
// (PRC_INTVL_LMP) for trading hubs and default load areas. OASIS answers
// with a zip holding one CSV (or an XML error), so the zip is opened here
// with zlib instead of adding a dependency.

import zlib from 'node:zlib';

const BASE = 'https://oasis.caiso.com/oasisapi/SingleZip';

export const CAISO_NODES = [
  { node: 'TH_NP15_GEN-APND', label: 'NP15 trading hub', re: /\bnp[- ]?15\b|north of path 15/i },
  { node: 'TH_SP15_GEN-APND', label: 'SP15 trading hub', re: /\bsp[- ]?15\b|south of path 15/i },
  { node: 'TH_ZP26_GEN-APND', label: 'ZP26 trading hub', re: /\bzp[- ]?26\b/i },
  { node: 'DLAP_PGAE-APND', label: 'PG&E default load area', re: /\bpg&?e\b|dlap[_ ]pgae/i },
  { node: 'DLAP_SCE-APND', label: 'SCE default load area', re: /\bsce\b|southern california edison|dlap[_ ]sce/i },
  { node: 'DLAP_SDGE-APND', label: 'SDG&E default load area', re: /\bsdg&?e\b|dlap[_ ]sdge/i },
];

export function isCaisoQuestion(text) {
  return /\bcaiso\b|california iso|\bcalifornia\b|\boasis\b|(?:TH|DLAP)_[A-Z0-9_]+-APND/i.test(text) || CAISO_NODES.slice(0, 3).some((n) => n.re.test(text));
}

export function caisoNode(text) {
  const explicit = String(text).match(/\b((?:TH|DLAP)_[A-Z0-9_]+-APND|[A-Z0-9]+_[A-Z0-9_]*_N\d{3})\b/);
  if (explicit) return { node: explicit[1], label: explicit[1], named: true };
  for (const n of CAISO_NODES) if (n.re.test(text)) return { ...n, named: true };
  return { ...CAISO_NODES[0], named: false };
}

// Reads the first file out of a zip buffer through the central directory,
// which holds the real sizes even when the local header leaves them at 0.
export function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('bad zip directory');
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const nameLen = buf.readUInt16LE(cd + 28);
  const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + compSize);
  const body = method === 0 ? data : zlib.inflateRawSync(data);
  return { name, text: body.toString('utf8') };
}

function oasisStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}-0000`;
}

export function parseOasisCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift().split(',');
  const col = (n) => head.indexOf(n);
  const iStart = col('INTERVALSTARTTIME_GMT');
  const iEnd = col('INTERVALENDTIME_GMT');
  const iType = col('LMP_TYPE');
  const iVal = col('MW') >= 0 ? col('MW') : col('VALUE');
  const byInterval = new Map();
  for (const l of lines) {
    const c = l.split(',');
    const k = c[iStart];
    if (!byInterval.has(k)) byInterval.set(k, { start: k, end: c[iEnd] });
    byInterval.get(k)[c[iType]] = Number(c[iVal]);
  }
  return [...byInterval.values()].sort((a, b) => a.start.localeCompare(b.start));
}

// market 'DAM' (hourly) or 'RTM' (5-minute). Returns intervals with LMP and
// its parts: MCE energy, MCC congestion, MCL losses, MGHG greenhouse gas.
export async function fetchCaisoLmp({ market, node, start, end, fetchImpl = fetch, timeoutMs = 20000 }) {
  const q = market === 'RTM'
    ? { queryname: 'PRC_INTVL_LMP', version: '3', market_run_id: 'RTM' }
    : { queryname: 'PRC_LMP', version: '12', market_run_id: 'DAM' };
  const url = `${BASE}?${new URLSearchParams({ ...q, startdatetime: oasisStamp(start), enddatetime: oasisStamp(end), node, resultformat: '6' })}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (res.status === 429 || res.status === 302) throw new Error(`OASIS busy (${res.status})`);
      if (!res.ok) throw new Error(`OASIS HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('OASIS sent an empty file');
      const file = unzipFirst(buf);
      if (/\.xml$/i.test(file.name) || file.text.startsWith('<')) {
        const why = file.text.match(/<(?:m:)?ERR_DESC>([^<]+)/)?.[1] ?? 'no data';
        return { intervals: [], error: why, url };
      }
      return { intervals: parseOasisCsv(file.text), url };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 5500));
    }
  }
  throw lastErr;
}
