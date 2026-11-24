// Ship identity from Wikidata (open, no key): a ship named in a question
// ("Ever Given", "MSC GULSUN") or an IMO number is matched to its IMO and
// MMSI numbers, flag, type, size and operator. This is registry data, not a
// position: it says which ship is meant so a live AIS feed can be read by
// MMSI, and so an answer can name the ship instead of refusing.

const API = 'https://www.wikidata.org/w/api.php';
const UA = { 'User-Agent': 'txlens-vessel-check/1.0 (ship identity lookup)', Accept: 'application/json' };
const cache = new Map();

async function wd(params, timeoutMs = 8000) {
  const res = await fetch(`${API}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return res.json();
}

// "the vessel 'Ever Given'", "vessel EVER GIVEN", "about MSC GULSUN".
export function shipNameIn(text) {
  const t = String(text ?? '').normalize('NFC');
  const quoted = t.match(/['"‘’“”]([A-Za-zÀ-ɏ][\wÀ-ɏ .'-]{1,40}?)['"‘’“”]/);
  if (quoted) return quoted[1].trim();
  const caps = t.match(/\b(?:vessel|ship|about|of|for)\s+((?:[A-ZÀ-Þ][A-ZÀ-Þ0-9.-]+\s?){1,4})/);
  if (caps) return caps[1].trim().replace(/[?.]$/, '');
  const named = t.match(/\b(?:vessel|ship)\s+(?:named\s+|called\s+)?((?:[A-Z][\w-]+\s?){1,4})/);
  return named ? named[1].trim() : null;
}

const SHIP_WORDS = /ship|vessel|tanker|carrier|container|bulk|ferry|cruise|liner|freighter|boat|tug|dredger|yacht/i;

function claim(e, p) {
  return e?.claims?.[p]?.map((c) => c.mainsnak?.datavalue?.value).filter((v) => v != null) ?? [];
}

async function labels(ids) {
  if (!ids.length) return {};
  const j = await wd({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'en' }).catch(() => null);
  const out = {};
  for (const [id, e] of Object.entries(j?.entities ?? {})) out[id] = e.labels?.en?.value ?? id;
  return out;
}

async function describe(id) {
  const j = await wd({ action: 'wbgetentities', ids: id, props: 'labels|descriptions|claims' });
  const e = j?.entities?.[id];
  if (!e) return null;
  if (!e.labels?.en) {
    const any = Object.values(e.labels ?? {})[0];
    if (any) e.labels = { ...e.labels, en: any };
  }
  const imo = claim(e, 'P458')[0] ?? null;
  const mmsi = claim(e, 'P587')[0] ?? null;
  const refIds = [...claim(e, 'P8047'), ...claim(e, 'P31'), ...claim(e, 'P137'), ...claim(e, 'P127')].map((v) => v.id).filter(Boolean);
  const names = await labels([...new Set(refIds)]);
  const first = (p) => { const v = claim(e, p)[0]; return v?.id ? names[v.id] ?? null : null; };
  const qty = (p) => { const v = claim(e, p)[0]; return v?.amount ? Number(v.amount) : null; };
  return {
    wikidata_id: id,
    name: e.labels?.en?.value ?? null,
    description: e.descriptions?.en?.value ?? null,
    imo: imo ? String(imo) : null,
    mmsi: mmsi ? String(mmsi) : null,
    flag: first('P8047'),
    ship_type: first('P31'),
    operator: first('P137') ?? first('P127'),
    length_m: qty('P2043'),
    gross_tonnage: qty('P1093'),
  };
}

// Finds a ship by name (best ship-like match) or by IMO number.
export async function lookupShip({ name = null, imo = null } = {}) {
  const key = `${name ?? ''}|${imo ?? ''}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit.value;
  let id = null;
  if (imo) {
    const s = await wd({ action: 'query', list: 'search', srsearch: `haswbstatement:P458=${imo}`, srlimit: '1' });
    id = s?.query?.search?.[0]?.title ?? null;
  }
  if (!id && name) {
    const plain = name.normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const q of [...new Set([name.normalize('NFC'), plain])]) {
      const s = await wd({ action: 'wbsearchentities', search: q, language: 'en', type: 'item', limit: '7' });
      const hits = s?.search ?? [];
      id = (hits.find((h) => SHIP_WORDS.test(h.description ?? '')) ?? null)?.id ?? null;
      if (id) break;
    }
  }
  const value = id ? await describe(id) : null;
  if (value && !value.name) value.name = name ?? (imo ? `IMO ${imo}` : null);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function identitySentence(s) {
  const bits = [];
  if (s.ship_type) bits.push(`a ${s.ship_type.toLowerCase()}`);
  if (s.flag) bits.push(`${s.flag} flag`);
  if (s.operator) bits.push(`operated or owned by ${s.operator}`);
  if (s.length_m) bits.push(`${s.length_m} m long`);
  if (s.gross_tonnage) bits.push(`${s.gross_tonnage.toLocaleString('en-US')} gross tonnage`);
  const ids = [s.imo ? `IMO ${s.imo}` : null, s.mmsi ? `MMSI ${s.mmsi}` : null].filter(Boolean).join(', ');
  return `${s.name}${ids ? ` (${ids})` : ''}${bits.length ? `, ${bits.join(', ')}` : ''}`;
}
