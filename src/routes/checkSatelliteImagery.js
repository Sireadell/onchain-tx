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
import { resolveLocation } from '../lib/weatherForecast.js';
import { parseCoordinates } from '../lib/questionParse.js';

const router = Router();

export function readPoint(params, text) {
  const lat = Number(firstUsableValue(params.lat, params.latitude));
  const lon = Number(firstUsableValue(params.lon, params.lng, params.longitude));
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  const m = String(text ?? '').match(/(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (m && Math.abs(Number(m[1])) <= 90 && Math.abs(Number(m[2])) <= 180) return { lat: Number(m[1]), lon: Number(m[2]) };
  return null;
}

// The place a question is about: "around the Hoover Dam", "of the downtown
// Seattle area", "Tesla Gigafactory in Austin, Texas". Most specific first,
// then the part after " in " ("Austin, Texas") as a broader fallback.
const PLACE_RE = /\b(?:around|of|at|near|over|for|in)\s+(?:the\s+)?(?:new\s+|recent\s+|downtown\s+)?([A-Z][\w.'-]*(?:[\s,]+(?:of\s+|de\s+)?[A-Z][\w.'-]*)*)/g;

export function placePhrases(text) {
  const out = [];
  const push = (v) => {
    const s = String(v ?? '').replace(/\s+(?:area|region|site|facility)$/i, '').replace(/[,\s]+$/, '').trim();
    if (s && !/^(?:Landsat|Sentinel|NASA|MODIS|What|Show)\b/.test(s) && !out.includes(s)) out.push(s);
  };
  const src = String(text ?? '');
  for (const m of src.matchAll(PLACE_RE)) {
    // "Tesla Gigafactory in Austin, Texas": the name alone matched the
    // Berlin plant, so the "in <place>" that follows comes first.
    const after = src.slice(m.index + m[0].length).match(/^\s+in\s+([A-Z][\w.'-]*(?:,?\s+[A-Z][\w.'-]*)*)/);
    if (after) {
      push(`${m[1]}, ${after[1]}`);
      push(after[1]);
    }
    push(m[1]);
  }
  for (const m of String(text ?? '').matchAll(/\bin\s+([A-Z][\w.'-]*(?:,?\s+[A-Z][\w.'-]*)*)/g)) push(m[1]);
  return out.slice(0, 3);
}

async function findPlace(text) {
  for (const q of placePhrases(text)) {
    try {
      const hits = await getJson(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`, { timeoutMs: 6000 });
      const hit = hits?.[0];
      if (hit) return { lat: Number(Number(hit.lat).toFixed(4)), lon: Number(Number(hit.lon).toFixed(4)), place: q };
    } catch { /* try the next phrase */ }
  }
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
  const text = freeTextParam(params);
  let point = readPoint(params, text);
  // Found live 2026-11-16: most refusals here named a place ("Hoover Dam",
  // "Austin, Texas") or wrote "47.6062° N, 122.3321° W". The weather
  // geocoder already reads both, so use it before giving up.
  if (!point && text) {
    const coords = parseCoordinates(text);
    if (coords) point = { lat: coords.latitude, lon: coords.longitude };
  }
  if (!point && text) point = await findPlace(text);
  if (!point && text) {
    try {
      const hit = await resolveLocation(text);
      if (hit) point = { lat: Number(hit.latitude.toFixed(4)), lon: Number(hit.longitude.toFixed(4)), place: hit.name };
    } catch { /* no place found, refused below */ }
  }
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
    summary: `Near ${point.place ? `${point.place} (${point.lat}, ${point.lon})` : `${point.lat}, ${point.lon}`}: ${lead} Latest NASA GIBS true-colour imagery is dated ${imageDate}. No image classification was run.`,
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
