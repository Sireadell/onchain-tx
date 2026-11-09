// SATELLITE_IMAGERY_ANALYSIS: what satellites and NASA event trackers show
// near a point. Runs no computer-vision model. It reports (1) active natural
// events (wildfires, storms, floods, volcanoes) within a radius from NASA
// EONET, which is built from satellite detections, and (2) the date of the
// latest NASA GIBS true-colour image for the point, with a tile link.
// Coordinates come from lat/lon params or "12.3, -45.6" written in the text.

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { getJson, upstreamDown, paramsOf } from '../lib/liveJson.js';

const router = Router();

export function readPoint(params, text) {
  const lat = Number(firstUsableValue(params.lat, params.latitude));
  const lon = Number(firstUsableValue(params.lon, params.lng, params.longitude));
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  const m = String(text ?? '').match(/(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (m && Math.abs(Number(m[1])) <= 90 && Math.abs(Number(m[2])) <= 180) return { lat: Number(m[1]), lon: Number(m[2]) };
  return null;
}

export function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function nearbyEvents(events, point, radiusKm) {
  const out = [];
  for (const e of events) {
    const g = [...(e.geometry ?? [])].reverse().find((x) => x.type === 'Point');
    if (!g) continue;
    const d = distanceKm(point, { lat: g.coordinates[1], lon: g.coordinates[0] });
    if (d <= radiusKm) out.push({ title: e.title, category: e.categories?.[0]?.title ?? 'Event', distance_km: Math.round(d), last_seen: g.date });
  }
  return out.sort((x, y) => x.distance_km - y.distance_km);
}

async function handle(req, res) {
  const params = paramsOf(req);
  const point = readPoint(params, freeTextParam(params));
  if (!point) return respondUnusableInput(res, 'Send lat and lon (for example lat=34.05 lon=-118.24) to analyse satellite-visible events near a point.');
  const radius = Math.min(Math.max(Number(firstUsableValue(params.radius_km, params.radius)) || 300, 10), 2000);
  let events;
  try {
    events = (await getJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&limit=200', { timeoutMs: 15000 })).events ?? [];
  } catch (err) {
    return upstreamDown(res, 'The NASA event source', err);
  }
  const near = nearbyEvents(events, point, radius);
  const imageDate = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const lead = near.length
    ? `${near.length} open natural event${near.length > 1 ? 's' : ''} within ${radius} km: ${near.slice(0, 3).map((e) => `${e.title} (${e.category}, ${e.distance_km} km)`).join('; ')}.`
    : `No open NASA-tracked natural events (wildfire, storm, flood, volcano) within ${radius} km in the last 30 days.`;
  res.json({
    status: 'ok',
    summary: `Near ${point.lat}, ${point.lon}: ${lead} Latest NASA GIBS true-colour imagery is dated ${imageDate}. No image classification was run.`,
    confidence: 0.7,
    canonical: `satellite-imagery:${point.lat.toFixed(2)},${point.lon.toFixed(2)}:${radius}`,
    latitude: point.lat,
    longitude: point.lon,
    radius_km: radius,
    events_nearby: near.length,
    events: near.slice(0, 10),
    imagery_date: imageDate,
    imagery_layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    source: 'NASA EONET and GIBS',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
