// VESSEL_TELEMETRY_VERIFY: live AIS position, speed, heading and declared
// draught for a ship by MMSI (9 digits) or IMO number (7 digits), from
// Digitraffic (Finnish Transport Agency, open, no key). Coverage is the AIS
// network around Finland and the Baltic. A ship with no recent position there
// but with registered details is answered as found, with the details and a
// sentence saying there is no recent position; an unknown ship is answered
// not_found with the same fields. Nothing here refuses with invalid_input.
// Draught is reported in metres (AIS sends tenths of a metre).

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { getJson, upstreamDown, paramsOf } from '../lib/liveJson.js';

const router = Router();
const BASE = 'https://meri.digitraffic.fi/api/ais/v1';

export function parseMmsi(value, text) {
  const raw = String(firstUsableValue(value) ?? '').trim();
  if (/^\d{9}$/.test(raw)) return raw;
  const m = String(text ?? '').match(/\b(\d{9})\b/);
  return m ? m[1] : null;
}

// A 7 digit IMO number, bare or written as "IMO 9225524".
export function parseImo(value, text) {
  const raw = String(firstUsableValue(value) ?? '').trim();
  const bare = raw.match(/^(?:imo\s*)?(\d{7})$/i);
  if (bare) return bare[1];
  const m = `${raw} ${String(text ?? '')}`.match(/\b(?:imo\s*[:#]?\s*)?(?<![\d.])(\d{7})(?![\d.])/i);
  return m ? m[1] : null;
}

const NAV_STATUS = {
  0: 'under way using engine',
  1: 'at anchor',
  2: 'not under command',
  3: 'restricted manoeuvrability',
  4: 'constrained by draught',
  5: 'moored',
  6: 'aground',
  7: 'engaged in fishing',
  8: 'under way sailing',
  11: 'power-driven vessel towing astern',
  12: 'power-driven vessel pushing ahead or towing alongside',
  14: 'AIS-SART, MOB or EPIRB active',
  15: 'not defined',
};

export function navigationalStatus(code) {
  if (code == null) return null;
  return NAV_STATUS[code] ?? `status code ${code}`;
}

export function shipTypeName(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return code ?? null;
  const exact = { 30: 'fishing vessel', 31: 'towing vessel', 32: 'towing vessel (large tow)', 33: 'dredger', 34: 'diving vessel', 35: 'military vessel', 36: 'sailing vessel', 37: 'pleasure craft', 50: 'pilot vessel', 51: 'search and rescue vessel', 52: 'tug', 53: 'port tender', 55: 'law enforcement vessel', 58: 'medical transport' };
  if (exact[n]) return exact[n];
  if (n >= 20 && n < 30) return 'wing in ground craft';
  if (n >= 40 && n < 50) return 'high speed craft';
  if (n >= 60 && n < 70) return 'passenger ship';
  if (n >= 70 && n < 80) return 'cargo ship';
  if (n >= 80 && n < 90) return 'tanker';
  if (n >= 90 && n < 100) return 'other ship';
  return `ship type code ${n}`;
}

// IMO to MMSI table from the full vessel register, cached for six hours.
const IMO_TTL_MS = 6 * 3600e3;
let imoCache = null;

export function resetImoCache() {
  imoCache = null;
}

async function imoToMmsi(imo) {
  if (!imoCache || Date.now() - imoCache.at > IMO_TTL_MS) {
    const list = await getJson(`${BASE}/vessels`, { timeoutMs: 25000 });
    const map = new Map();
    for (const v of Array.isArray(list) ? list : []) {
      if (v?.imo != null && v?.mmsi != null && Number(v.imo) > 0) map.set(String(v.imo), String(v.mmsi));
    }
    imoCache = { at: Date.now(), map };
  }
  return imoCache.map.get(String(imo)) ?? null;
}

function isoOrNull(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function metaFields(meta) {
  return {
    name: meta?.name?.trim?.() || null,
    imo: meta?.imo != null && Number(meta.imo) > 0 ? meta.imo : null,
    call_sign: meta?.callSign?.trim?.() || null,
    ship_type: meta?.shipType != null ? shipTypeName(meta.shipType) : null,
    draught_m: meta?.draught != null ? meta.draught / 10 : null,
    destination: meta?.destination?.trim?.() || null,
    eta: isoOrNull(meta?.eta),
  };
}

const NO_POSITION = {
  latitude: null,
  longitude: null,
  speed_knots: null,
  course_deg: null,
  heading_deg: null,
  navigational_status: null,
  position_time: null,
};

function detailsSentence(m) {
  const parts = [];
  if (m.ship_type) parts.push(`a ${m.ship_type}`);
  if (m.imo) parts.push(`IMO ${m.imo}`);
  if (m.call_sign) parts.push(`call sign ${m.call_sign}`);
  const extra = [];
  if (m.draught_m != null) extra.push(`reported draught ${m.draught_m} m`);
  if (m.destination) extra.push(`destination ${m.destination}`);
  if (m.eta) extra.push(`ETA ${m.eta.slice(0, 16).replace('T', ' ')} UTC`);
  return { parts, extra };
}

function respondNotFound(res, mmsi, imo, reason) {
  return res.json({
    summary: reason,
    status: 'not_found',
    found: false,
    confidence: 0.6,
    canonical: `vessel-telemetry:${mmsi ?? imo ?? 'unknown'}`,
    mmsi: mmsi != null ? Number(mmsi) : null,
    name: null,
    imo: imo != null ? Number(imo) : null,
    call_sign: null,
    ship_type: null,
    draught_m: null,
    destination: null,
    eta: null,
    ...NO_POSITION,
    reason,
    source: 'Digitraffic AIS (Fintraffic)',
    checked_at: new Date().toISOString(),
  });
}

async function handle(req, res) {
  const params = paramsOf(req);
  const raw = firstUsableValue(params.mmsi, params.vessel, params.ship, params.id, params.imo);
  const text = freeTextParam(params);
  let mmsi = parseMmsi(raw, text);
  let imo = null;
  if (!mmsi) {
    imo = parseImo(raw, text);
    if (!imo) {
      return respondNotFound(res, null, null, `No ship can be identified from ${raw != null ? `"${String(raw).slice(0, 60)}"` : 'this request'}: a ship is named by its 9 digit MMSI (for example 230629000) or its 7 digit IMO number. Coverage is the AIS network around Finland and the Baltic, so no details are given rather than guessed.`);
    }
    try {
      mmsi = await imoToMmsi(imo);
    } catch {
      return respondNotFound(res, null, imo, `IMO ${imo} could not be matched to a ship because the vessel register for Finland and the Baltic did not respond. No details are given rather than guessed.`);
    }
    if (!mmsi) {
      return respondNotFound(res, null, imo, `IMO ${imo} is not in the Finland and Baltic AIS vessel register, so there is no name, position, draught or destination to report. That does not mean the ship does not exist elsewhere.`);
    }
  }

  let loc;
  let meta = null;
  try {
    loc = await getJson(`${BASE}/locations?mmsi=${mmsi}`);
    meta = await getJson(`${BASE}/vessels/${mmsi}`).catch(() => null);
  } catch (err) {
    return upstreamDown(res, 'The AIS data source', err);
  }
  const m = metaFields(meta);
  const f = loc?.features?.[0];

  if (!f) {
    if (!(m.name || m.imo || m.call_sign)) {
      return respondNotFound(res, mmsi, imo, `Vessel ${mmsi} is not in the AIS network I can read (Finland and the Baltic), so there is no position or registered detail to report. That does not mean it is not at sea elsewhere.`);
    }
    const { parts, extra } = detailsSentence(m);
    return res.json({
      summary: `${m.name ?? `Vessel ${mmsi}`}${parts.length ? `, ${parts.join(', ')}` : ''} (MMSI ${mmsi}), has no recent AIS position in the Baltic feed${extra.length ? `; ${extra.join(', ')}` : ''}. Its last known location cannot be given, and that does not mean it is not at sea elsewhere.`,
      status: 'ok',
      found: true,
      confidence: 0.8,
      canonical: `vessel-telemetry:${mmsi}`,
      mmsi: Number(mmsi),
      ...m,
      ...NO_POSITION,
      position_available: false,
      source: 'Digitraffic AIS (Fintraffic)',
      checked_at: new Date().toISOString(),
    });
  }

  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  const seen = new Date(p.timestampExternal).toISOString();
  const navStatus = navigationalStatus(p.navStat);
  res.json({
    summary: `Vessel ${mmsi}${m.name ? ` (${m.name})` : ''} was at ${lat.toFixed(4)}, ${lon.toFixed(4)} at ${seen.slice(0, 16).replace('T', ' ')} UTC, speed ${p.sog} knots, course ${p.cog} degrees, heading ${p.heading}${navStatus ? `, ${navStatus}` : ''}${m.draught_m != null ? `, draught ${m.draught_m} m` : ''}${m.destination ? `, destination ${m.destination}` : ''}.`,
    status: 'ok',
    found: true,
    confidence: 0.9,
    canonical: `vessel-telemetry:${mmsi}`,
    mmsi: Number(mmsi),
    ...m,
    latitude: lat,
    longitude: lon,
    speed_knots: p.sog,
    course_deg: p.cog,
    heading_deg: p.heading,
    navigational_status: navStatus,
    position_time: seen,
    position_available: true,
    source: 'Digitraffic AIS (Fintraffic)',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
