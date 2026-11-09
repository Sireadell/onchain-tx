// VESSEL_TELEMETRY_VERIFY: live AIS position, speed, heading and declared
// draught for a ship by MMSI, from Digitraffic (Finnish Transport Agency,
// open, no key). Coverage is the AIS network around Finland and the Baltic;
// a vessel outside it is reported as not currently seen rather than guessed.
// Draught is reported in metres (AIS sends tenths of a metre).

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { getJson, upstreamDown, paramsOf } from '../lib/liveJson.js';

const router = Router();
const BASE = 'https://meri.digitraffic.fi/api/ais/v1';

export function parseMmsi(value, text) {
  const raw = String(firstUsableValue(value) ?? '').trim();
  if (/^\d{9}$/.test(raw)) return raw;
  const m = String(text ?? '').match(/\b(\d{9})\b/);
  return m ? m[1] : null;
}

async function handle(req, res) {
  const params = paramsOf(req);
  const raw = firstUsableValue(params.mmsi, params.vessel, params.ship, params.id);
  const mmsi = parseMmsi(raw, freeTextParam(params));
  if (!mmsi) return respondUnusableInput(res, `${quoteParam(raw)} is not a ship identifier. Pass the 9 digit MMSI, for example 230629000.`);
  let loc;
  let meta = null;
  try {
    loc = await getJson(`${BASE}/locations?mmsi=${mmsi}`);
    meta = await getJson(`${BASE}/vessels/${mmsi}`).catch(() => null);
  } catch (err) {
    return upstreamDown(res, 'The AIS data source', err);
  }
  const f = loc?.features?.[0];
  if (!f) {
    return res.json({
      status: 'not_found',
      summary: `Vessel ${mmsi}${meta?.name ? ` (${meta.name})` : ''} is not currently reporting in the AIS network I can read (Finland and the Baltic). That does not mean it is not at sea elsewhere.`,
      confidence: 0.4,
      canonical: `vessel-telemetry:${mmsi}`,
      mmsi: Number(mmsi),
      checked_at: new Date().toISOString(),
    });
  }
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  const draught = meta?.draught != null ? meta.draught / 10 : null;
  const seen = new Date(p.timestampExternal).toISOString();
  res.json({
    status: 'ok',
    summary: `Vessel ${mmsi}${meta?.name ? ` (${meta.name})` : ''} was at ${lat.toFixed(4)}, ${lon.toFixed(4)} at ${seen.slice(0, 16).replace('T', ' ')} UTC, speed ${p.sog} knots, course ${p.cog} degrees, heading ${p.heading}${draught != null ? `, draught ${draught} m` : ''}${meta?.destination ? `, destination ${meta.destination}` : ''}.`,
    confidence: 0.9,
    canonical: `vessel-telemetry:${mmsi}`,
    mmsi: Number(mmsi),
    name: meta?.name ?? null,
    imo: meta?.imo ?? null,
    latitude: lat,
    longitude: lon,
    speed_knots: p.sog,
    course_deg: p.cog,
    heading_deg: p.heading,
    draught_m: draught,
    destination: meta?.destination ?? null,
    position_time: seen,
    source: 'Digitraffic AIS (Fintraffic)',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
