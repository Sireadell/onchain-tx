// Worldwide live AIS from aisstream.io (terrestrial receivers, free account
// key). Off unless AISSTREAM_API_KEY is set. Two websocket subscriptions:
//   A: boxes around major ports, every ship, for port congestion
//   B: the whole world, filtered to ships someone asked about (by MMSI)
// Only the latest report per ship is kept in memory, and anything not heard
// for 6 hours is dropped. Nothing here guesses: a port with too few ships
// heard is reported as thin coverage, and an unheard ship as not heard.

const URL_WS = 'wss://stream.aisstream.io/v0/stream';
const TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'];
const KEEP_MS = 6 * 3600e3;

export const AIS_PORTS = [
  { port: 'Rotterdam', unlocode: 'NLRTM', lat: 51.98, lon: 4.05, km: 40, names: ['rotterdam', 'maasvlakte', 'europoort'] },
  { port: 'Antwerp', unlocode: 'BEANR', lat: 51.3, lon: 4.3, km: 30, names: ['antwerp', 'antwerpen', 'anvers'] },
  { port: 'Hamburg', unlocode: 'DEHAM', lat: 53.54, lon: 9.95, km: 30, names: ['hamburg'] },
  { port: 'Felixstowe', unlocode: 'GBFXT', lat: 51.95, lon: 1.32, km: 30, names: ['felixstowe'] },
  { port: 'London Gateway', unlocode: 'GBLGP', lat: 51.5, lon: 0.45, km: 25, names: ['london gateway', 'london'] },
  { port: 'Algeciras', unlocode: 'ESALG', lat: 36.13, lon: -5.43, km: 25, names: ['algeciras'] },
  { port: 'Valencia', unlocode: 'ESVLC', lat: 39.44, lon: -0.31, km: 25, names: ['valencia'] },
  { port: 'Piraeus', unlocode: 'GRPIR', lat: 37.94, lon: 23.6, km: 25, names: ['piraeus'] },
  { port: 'Genoa', unlocode: 'ITGOA', lat: 44.4, lon: 8.9, km: 25, names: ['genoa', 'genova'] },
  { port: 'Gothenburg', unlocode: 'SEGOT', lat: 57.69, lon: 11.85, km: 25, names: ['gothenburg', 'goteborg'] },
  { port: 'Constanta', unlocode: 'ROCND', lat: 44.17, lon: 28.66, km: 30, names: ['constanta'] },
  { port: 'Singapore', unlocode: 'SGSIN', lat: 1.26, lon: 103.83, km: 35, names: ['singapore'] },
  { port: 'Tanjung Pelepas', unlocode: 'MYTPP', lat: 1.36, lon: 103.55, km: 25, names: ['tanjung pelepas'] },
  { port: 'Port Klang', unlocode: 'MYPKG', lat: 2.99, lon: 101.35, km: 30, names: ['port klang', 'klang'] },
  { port: 'Shanghai', unlocode: 'CNSHA', lat: 31.0, lon: 121.95, km: 60, names: ['shanghai', 'yangshan'] },
  { port: 'Ningbo-Zhoushan', unlocode: 'CNNGB', lat: 29.93, lon: 121.85, km: 40, names: ['ningbo', 'zhoushan'] },
  { port: 'Hong Kong', unlocode: 'HKHKG', lat: 22.3, lon: 114.15, km: 30, names: ['hong kong'] },
  { port: 'Busan', unlocode: 'KRPUS', lat: 35.08, lon: 129.07, km: 30, names: ['busan', 'pusan'] },
  { port: 'Tokyo', unlocode: 'JPTYO', lat: 35.55, lon: 139.8, km: 30, names: ['tokyo', 'yokohama'] },
  { port: 'Los Angeles / Long Beach', unlocode: 'USLAX', lat: 33.72, lon: -118.22, km: 30, names: ['los angeles', 'long beach', 'san pedro'] },
  { port: 'New York / New Jersey', unlocode: 'USNYC', lat: 40.62, lon: -74.05, km: 30, names: ['new york', 'new jersey', 'newark'] },
  { port: 'Houston', unlocode: 'USHOU', lat: 29.5, lon: -94.9, km: 50, names: ['houston', 'galveston'] },
  { port: 'Savannah', unlocode: 'USSAV', lat: 32.05, lon: -80.95, km: 30, names: ['savannah'] },
  { port: 'Santos', unlocode: 'BRSSZ', lat: -23.99, lon: -46.3, km: 30, names: ['santos'] },
  { port: 'Jebel Ali', unlocode: 'AEJEA', lat: 25.01, lon: 55.05, km: 30, names: ['jebel ali', 'dubai'] },
  { port: 'Jeddah', unlocode: 'SAJED', lat: 21.48, lon: 39.15, km: 30, names: ['jeddah', 'jiddah'] },
  { port: 'Colombo', unlocode: 'LKCMB', lat: 6.95, lon: 79.84, km: 25, names: ['colombo'] },
  { port: 'Nhava Sheva (JNPT)', unlocode: 'INNSA', lat: 18.95, lon: 72.95, km: 30, names: ['nhava sheva', 'jnpt', 'mumbai'] },
  { port: 'Durban', unlocode: 'ZADUR', lat: -29.88, lon: 31.05, km: 25, names: ['durban'] },
  { port: 'Lagos (Apapa / Tin Can / Lekki)', unlocode: 'NGAPP', lat: 6.38, lon: 3.45, km: 40, names: ['lagos', 'apapa', 'tin can', 'lekki'] },
];

export function findAisPort(text) {
  const t = ` ${String(text ?? '').toLowerCase()} `;
  for (const p of AIS_PORTS) if (t.includes(` ${p.unlocode.toLowerCase()}`) || t.includes(`(${p.unlocode.toLowerCase()})`)) return p;
  for (const p of AIS_PORTS) for (const n of p.names) if (t.includes(n)) return p;
  return null;
}

function boxOf(p) {
  const dLat = p.km / 111.32;
  const dLon = p.km / (111.32 * Math.cos((p.lat * Math.PI) / 180));
  return [[p.lat - dLat, p.lon - dLon], [p.lat + dLat, p.lon + dLon]];
}

export function distanceKm(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const state = {
  ships: new Map(),
  tracked: new Map(), // mmsi -> last asked (ms)
  startedAt: null,
  sockets: { A: null, B: null },
  messages: 0,
  lastMessageAt: null,
};

export function aisEnabled() {
  return Boolean(process.env.AISSTREAM_API_KEY) && typeof globalThis.WebSocket === 'function';
}

export function aisStatus() {
  return { enabled: aisEnabled(), started_at: state.startedAt, ships: state.ships.size, messages: state.messages, last_message_at: state.lastMessageAt, tracked: state.tracked.size };
}

// One AIS message into the ship table. Exported for tests.
export function ingest(msg, now = Date.now()) {
  const meta = msg?.MetaData ?? {};
  const mmsi = String(meta.MMSI ?? meta.MMSI_String ?? '');
  if (!/^\d{9}$/.test(mmsi)) return;
  state.messages += 1;
  state.lastMessageAt = now;
  const s = state.ships.get(mmsi) ?? { mmsi };
  if (meta.ShipName && String(meta.ShipName).trim()) s.name = String(meta.ShipName).trim();
  const type = msg.MessageType;
  const body = msg.Message?.[type] ?? {};
  if (type === 'ShipStaticData') {
    s.shipType = body.Type ?? s.shipType;
    s.destination = String(body.Destination ?? '').trim() || s.destination;
    s.draught = body.MaximumStaticDraught ?? s.draught;
    s.imo = body.ImoNumber ? String(body.ImoNumber) : s.imo;
    const d = body.Dimension;
    if (d && (d.A || d.B)) s.length = Number(d.A ?? 0) + Number(d.B ?? 0);
    const e = body.Eta;
    if (e && e.Month && e.Day) s.eta = `${String(e.Month).padStart(2, '0')}-${String(e.Day).padStart(2, '0')} ${String(e.Hour ?? 0).padStart(2, '0')}:${String(e.Minute ?? 0).padStart(2, '0')}`;
    s.staticAt = now;
  } else {
    const lat = Number(body.Latitude ?? meta.latitude);
    const lon = Number(body.Longitude ?? meta.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    const nav = body.NavigationalStatus;
    if (nav === 1 && s.nav !== 1) s.anchorSince = now;
    if (nav !== 1) s.anchorSince = null;
    Object.assign(s, { lat, lon, sog: body.Sog ?? null, cog: body.Cog ?? null, heading: body.TrueHeading === 511 ? null : body.TrueHeading ?? null, nav: nav ?? null, t: now, reported: meta.time_utc ?? null });
  }
  state.ships.set(mmsi, s);
}

function prune(now = Date.now()) {
  for (const [k, s] of state.ships) if ((s.t ?? s.staticAt ?? 0) < now - KEEP_MS) state.ships.delete(k);
  for (const [k, at] of state.tracked) if (at < now - 7 * 86400e3) state.tracked.delete(k);
}

function connect(name, subscription) {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) return;
  let ws;
  try { ws = new globalThis.WebSocket(URL_WS); } catch { return; }
  state.sockets[name] = ws;
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => ws.send(JSON.stringify({ APIKey: key, ...subscription, FilterMessageTypes: TYPES })));
  ws.addEventListener('message', (ev) => {
    try {
      const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      ingest(JSON.parse(text));
    } catch { /* one bad message is skipped */ }
  });
  ws.addEventListener('close', () => {
    if (state.sockets[name] === ws) {
      state.sockets[name] = null;
      setTimeout(() => restart(name), 15000).unref?.();
    }
  });
  ws.addEventListener('error', () => { /* close follows */ });
}

function subscriptionB() {
  const mmsis = [...state.tracked.keys()].slice(-50);
  return mmsis.length ? { BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: mmsis } : null;
}

function restart(name) {
  if (!aisEnabled()) return;
  if (name === 'A') connect('A', { BoundingBoxes: AIS_PORTS.map(boxOf) });
  else {
    const sub = subscriptionB();
    if (sub) connect('B', sub);
  }
}

let bTimer = null;
export function startAis() {
  if (!aisEnabled() || state.startedAt) return false;
  state.startedAt = Date.now();
  restart('A');
  setInterval(() => prune(), 10 * 60e3).unref?.();
  return true;
}

// Ask the feed to follow a ship by MMSI from now on.
export function trackShip(mmsi) {
  if (!aisEnabled() || !/^\d{9}$/.test(String(mmsi))) return;
  const known = state.tracked.has(String(mmsi));
  state.tracked.set(String(mmsi), Date.now());
  if (known) return;
  clearTimeout(bTimer);
  bTimer = setTimeout(() => {
    const old = state.sockets.B;
    state.sockets.B = null;
    try { old?.close(); } catch { /* already closed */ }
    restart('B');
  }, 2000);
  bTimer.unref?.();
}

export function shipByMmsi(mmsi) {
  return state.ships.get(String(mmsi)) ?? null;
}

export function shipByName(name) {
  const want = String(name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!want) return null;
  let best = null;
  for (const s of state.ships.values()) {
    if (s.name && s.name.toUpperCase().replace(/[^A-Z0-9]/g, '') === want && (!best || (s.t ?? 0) > (best.t ?? 0))) best = s;
  }
  return best;
}

// Cargo ships and tankers (AIS types 70-89), 80 m or longer when the size is
// known, heard within the port radius in the last 2 hours.
export function portCongestion(p, now = Date.now()) {
  const centre = { lat: p.lat, lon: p.lon };
  const recent = [];
  for (const s of state.ships.values()) {
    if (s.t == null || now - s.t > 2 * 3600e3 || s.lat == null) continue;
    if (distanceKm(centre, s) > p.km) continue;
    const t = Number(s.shipType);
    const cargo = Number.isFinite(t) ? t >= 70 && t <= 89 : true;
    if (!cargo || (s.length && s.length < 80)) continue;
    recent.push(s);
  }
  const anchored = recent.filter((s) => s.nav === 1);
  const moored = recent.filter((s) => s.nav === 5);
  const underway = recent.filter((s) => s.nav === 0 || s.nav === 8 || (s.sog != null && s.sog > 1 && s.nav !== 1 && s.nav !== 5));
  const waits = anchored.map((s) => (now - (s.anchorSince ?? now)) / 3600e3);
  const observedH = state.startedAt ? (now - state.startedAt) / 3600e3 : 0;
  return {
    in_area: recent.length,
    waiting_at_anchor: anchored.length,
    moored: moored.length,
    underway: underway.length,
    avg_wait_hours_so_far: waits.length ? Number((waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(1)) : null,
    longest_wait_hours_so_far: waits.length ? Number(Math.max(...waits).toFixed(1)) : null,
    observed_hours: Number(observedH.toFixed(1)),
    berth_occupancy_proxy: recent.length ? Number((moored.length / Math.max(moored.length + anchored.length, 1)).toFixed(2)) : null,
  };
}

export function resetAisForTests() {
  state.ships.clear();
  state.tracked.clear();
  state.startedAt = Date.now() - 6 * 3600e3;
  state.messages = 0;
}
