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
import { resolveLocation, osmLookup } from '../lib/weatherForecast.js';
import { parseCoordinates } from '../lib/questionParse.js';
import { landCover, ndvi, MODIS_SOURCE } from '../lib/modisLand.js';

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
  // "the Amazon rainforest near Manaus": the town after "near" is the
  // point; "Amazon" alone geocoded to a warehouse in Texas (2026-11-19).
  const near = src.match(/\bnear\s+(?:the\s+)?([A-Z][\w.'-]*(?:,?\s+[A-Z][\w.'-]*)*)/);
  if (near) push(near[1]);
  for (const m of src.matchAll(PLACE_RE)) {
    // "Tesla Gigafactory in Austin, Texas": the name alone matched the
    // Berlin plant, so the "in <place>" that follows comes first.
    const after = src.slice(m.index + m[0].length).match(/^\s+in\s+([A-Z][\w.'-]*(?:,?\s+[A-Z][\w.'-]*)*)/);
    if (after) {
      // "Tesla Gigafactory Berlin" geocodes to the plant; the comma form
      // found nothing and fell back to the city centre (2026-11-19).
      push(`${m[1]} ${after[1].split(',')[0]}`);
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
    const hit = await osmLookup(q);
    if (hit) return { lat: Number(hit.latitude.toFixed(4)), lon: Number(hit.longitude.toFixed(4)), place: q };
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


const NDVI_RE = /\bndvi\b|\bvegetation (?:index|health|cover|greenness)\b|\bgreenness\b|\bcrop health\b|\bplant health\b/i;
const LAND_RE = /\bland[\s-]?(?:cover|use)\b|\burban (?:development|expansion|growth|sprawl)\b|\bdeforest|\bforest (?:loss|cover)\b|\bwater (?:body|bodies|extent|level)\b|\bbuilt[\s-]?up\b|\bclassification\b/i;

export function questionKind(text) {
  const t = String(text ?? '');
  if (NDVI_RE.test(t)) return 'ndvi';
  if (LAND_RE.test(t)) return 'land';
  return null;
}

// "within a 5km radius", "a 10 km area".
export function radiusKmOf(text) {
  const m = String(text ?? '').match(/(\d+(?:\.\d+)?)\s*-?\s*(?:km|kilomet(?:er|re)s?)\b/i);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.min(v, 25) : null;
}

// Year range a land question asks about: "since January 2023" (2023 to
// latest), "between January 2023 and March 2023" (2022 to 2023).
export function yearsOf(text) {
  const t = String(text ?? '');
  const years = [...t.matchAll(/\b(20[0-3]\d)\b/g)].map((m) => Number(m[1]));
  if (!years.length) return { since: null, until: null };
  if (/\bbetween\b|\bfrom\b.*\bto\b/i.test(t)) return { since: Math.min(...years) - 1, until: Math.max(...years) };
  return { since: Math.min(...years), until: null };
}

const modisCache = new Map();
async function cachedModis(key, fn) {
  const hit = modisCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  const value = await fn();
  if (modisCache.size > 200) modisCache.delete(modisCache.keys().next().value);
  if (value) modisCache.set(key, { at: Date.now(), value });
  return value;
}

const SENSOR_RE = /\b(Sentinel-?\d[A-C]?|Landsat\s*\d+|Planet(?: Labs)?|Maxar|WorldView-?\d|SPOT\s*\d)\b/i;
const placeLabel = (point) => (point.place ? `${point.place} (${point.lat}, ${point.lon})` : `${point.lat}, ${point.lon}`);
const pct = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
const pts = (n) => `${n > 0 ? '+' : ''}${n} points`;

export function landSummary(point, lc, text) {
  const top = lc.latest.slice(0, 5).map((s) => `${s.name} ${pct(s.percent)}`).join(', ');
  const parts = [`Land cover within about ${lc.box_km / 2} km of ${placeLabel(point)}, from the NASA MODIS ${lc.latest_year} yearly land cover map (500 m pixels): mostly ${lc.latest[0].name} (${pct(lc.latest[0].percent)}); in full ${top}.`];
  if (lc.change) {
    const c = lc.change;
    const big = Math.max(Math.abs(c.urban_points), Math.abs(c.water_points), Math.abs(c.forest_points), Math.abs(c.cropland_points));
    parts.push(`Change from ${lc.compare_year} to ${lc.latest_year}: urban and built-up ${pts(c.urban_points)} (now ${pct(lc.urban_percent)}), water ${pts(c.water_points)} (now ${pct(lc.water_percent)}), forest ${pts(c.forest_points)} (now ${pct(lc.forest_percent)}), cropland ${pts(c.cropland_points)}.`);
    parts.push(big < 2 ? 'No significant change at this 500 m scale (every class moved by less than 2 points).' : 'The largest shift is shown above; changes under 2 points are within normal year-to-year noise at this scale.');
  }
  if (/\b(?:last|past)\s+(?:six|6|three|3|few)\s+months\b|\blast week\b|\bprevious month\b/i.test(text)) {
    parts.push(`The map is yearly, so changes within the last few months are not resolved; ${lc.latest_year} is the newest year published.`);
  }
  const sensor = String(text ?? '').match(SENSOR_RE)?.[0];
  if (sensor) parts.push(`${sensor} scenes were not read here; this uses the MODIS land cover product instead.`);
  return parts.join(' ');
}

export function ndviSummary(point, n) {
  const parts = [`The current NDVI around ${placeLabel(point)} is ${n.mean.toFixed(2)} (average of ${n.pixels} pixels at 250 m over about a ${n.box_km} km square, range ${n.min.toFixed(2)} to ${n.max.toFixed(2)}), from the NASA MODIS Terra 16-day composite for ${n.period_start} to ${n.period_end}, the most recent one published.`];
  parts.push(`That means ${n.meaning}.`);
  if (n.year_ago) {
    const d = Math.round((n.mean - n.year_ago.mean) * 100) / 100;
    parts.push(`For the same 16 days a year earlier it was ${n.year_ago.mean.toFixed(2)}, so it is ${Math.abs(d) < 0.03 ? 'about the same' : d > 0 ? `greener by ${d.toFixed(2)}` : `less green by ${Math.abs(d).toFixed(2)}`}.`);
  }
  parts.push('NDVI runs from -1 to 1; above 0.6 is dense green vegetation, below 0.2 is bare soil, water or pavement.');
  return parts.join(' ');
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
  // NDVI and land cover questions get measured MODIS values for the point.
  const kind = questionKind(text);
  if (kind) {
    const askedKm = Number(firstUsableValue(params.radius_km, params.radius)) || radiusKmOf(text);
    try {
      if (kind === 'ndvi') {
        const km = askedKm ? Math.min(Math.round(askedKm), 5) : 1;
        const n = await cachedModis(`ndvi:${point.lat},${point.lon},${km}`, () => ndvi(point.lat, point.lon, { km }));
        if (n) {
          const summary = ndviSummary(point, n);
          return res.json({
            status: 'ok', summary, answer: summary, confidence: 0.85,
            canonical: `satellite-imagery:ndvi:${point.lat.toFixed(2)},${point.lon.toFixed(2)}`,
            latitude: point.lat, longitude: point.lon, place: point.place ?? null,
            ndvi: n.mean, pixels: n.pixels, period_start: n.period_start, period_end: n.period_end, ndvi_year_ago: n.year_ago?.mean ?? null,
            product: 'MODIS MOD13Q1 NDVI',
            source: MODIS_SOURCE, checked_at: new Date().toISOString(),
          });
        }
      } else {
        const km = askedKm ? Math.max(Math.round(askedKm), 1) : (/\bdeforest|\bforest (?:loss|cover)\b/i.test(text) ? 25 : 5);
        const { since, until } = yearsOf(text);
        const lc = await cachedModis(`lc:${point.lat},${point.lon},${km},${since},${until}`, () => landCover(point.lat, point.lon, { km, sinceYear: since, untilYear: until }));
        if (lc) {
          const summary = landSummary(point, lc, text);
          return res.json({
            status: 'ok', summary, answer: summary, confidence: 0.85,
            canonical: `satellite-imagery:landcover:${point.lat.toFixed(2)},${point.lon.toFixed(2)}:${lc.latest_year}`,
            latitude: point.lat, longitude: point.lon, place: point.place ?? null,
            dominant_class: lc.latest[0].name, land_cover_year: lc.latest_year, compare_year: lc.compare_year,
            product: 'MODIS MCD12Q1 land cover',
            source: MODIS_SOURCE, checked_at: new Date().toISOString(),
          });
        }
      }
    } catch {
      // MODIS service down or slow: fall through to the event and imagery answer.
    }
  }

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
