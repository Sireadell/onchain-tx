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
import { sceneReport, S2_SOURCE } from '../lib/sentinel2.js';

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
const PLACE_RE = /\b(?:around|of|at|near|over|for|in|surrounding|covering|across)\s+(?:the\s+)?(?:new\s+|recent\s+|downtown\s+)?([A-Z][\w.'-]*(?:[\s,]+(?:of\s+|de\s+)?[A-Z][\w.'-]*)*)/g;

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
    // Also "the new Amazon fulfillment center in Goodyear, Arizona" and
    // "Elm Street and Maple Avenue in Springfield, Illinois": "Amazon" alone
    // geocoded to Minnesota (2026-11-22), so the town after "in" leads.
    const after = src.slice(m.index + m[0].length).match(/^[^.?;]{0,45}?\s+in\s+([A-Z][\w.'-]*(?:,?\s+[A-Z][\w.'-]*)*)/);
    if (after) {
      // "Tesla Gigafactory Berlin" geocodes to the plant; the comma form
      // found nothing and fell back to the city centre (2026-11-19).
      if (after[1].includes(',')) push(`${m[1]}, ${after[1]}`);
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
const EVENT_RE = /\b(?:flood|flooding|wildfire|fire|storm|cyclone|hurricane|typhoon|volcan|eruption|landslide|severe weather|drought|dust)\w*/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Dates named in the question, in order: "October 26, 2023", "January 1st,
// 2024", "January 2023", "2025-09-26".
export function datesIn(text) {
  const t = String(text ?? '');
  const out = [];
  const re = /\b(20\d{2})-(\d{2})-(\d{2})\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(20\d{2})\b/gi;
  for (const m of t.matchAll(re)) {
    const d = m[1] ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.UTC(+m[6], MONTHS.indexOf(m[4].toLowerCase().slice(0, 3)), m[5] ? +m[5] : 1);
    out.push({ at: d, index: m.index });
  }
  return out;
}

// Which scene to read and what to compare it with.
export function sceneWindow(text, now = Date.now()) {
  const t = String(text ?? '');
  const ds = datesIn(t);
  const day = 86400e3;
  let after = null;
  let compareTo = null;
  let label = 'the same season a year earlier';
  if (/\bbetween\b/i.test(t) && ds.length >= 2) {
    after = ds[ds.length - 1].at; compareTo = ds[0].at; label = `the scene nearest ${new Date(compareTo).toISOString().slice(0, 10)}`;
  } else if (/on or after|captured (?:on|after)|after\b/i.test(t) && ds.length) {
    after = ds[0].at;
    if (/previous month|month before/i.test(t)) { compareTo = after - 30 * day; label = 'the month before'; }
  } else if (/\bsince\b/i.test(t) && ds.length) {
    compareTo = ds[0].at; label = `the scene nearest ${new Date(compareTo).toISOString().slice(0, 10)}`;
  } else if (/previous month|last month|a month ago/i.test(t)) { compareTo = now - 30 * day; label = 'about a month earlier'; }
  else if (/(?:six|6) months/i.test(t)) { compareTo = now - 182 * day; label = 'about six months earlier'; }
  else if (/(?:three|3) months/i.test(t)) { compareTo = now - 91 * day; label = 'about three months earlier'; }
  else if (/last week|past week|this week/i.test(t)) { compareTo = now - 14 * day; label = 'about two weeks earlier (Sentinel-2 passes every 5 days)'; }
  else if (ds.length) { after = ds[0].at; }
  return { after, compareTo, label };
}

const idx = (i) => (i ? `NDVI ${i.ndvi?.mean ?? 'n/a'}, built-up index (NDBI) ${i.ndbi?.mean ?? 'n/a'}, water index (NDWI) ${i.ndwi?.mean ?? 'n/a'}` : 'indexes not available');

export function sceneSummary(point, rep, text, label) {
  const L = rep.latest;
  const parts = [`Sentinel-2 scene ${L.id} (${String(L.platform ?? '').toUpperCase() || 'Sentinel-2'}, tile ${L.tile ?? 'n/a'}) captured ${L.datetime.slice(0, 16).replace('T', ' ')} UTC with ${L.cloud_cover}% cloud covers ${placeLabel(point)}. Over a ${rep.box_km} km square around the point (10 m pixels): ${idx(L.indexes)}.`];
  if (rep.baseline) {
    const B = rep.baseline;
    parts.push(`Compared with ${label}, scene ${B.id} from ${B.datetime.slice(0, 10)} (${B.cloud_cover}% cloud): ${idx(B.indexes)}.`);
    const mDiff = Math.abs(new Date(L.datetime).getUTCMonth() - new Date(B.datetime).getUTCMonth());
    if (Math.min(mDiff, 12 - mDiff) >= 3) parts.push('The two scenes are from different seasons, so part of any vegetation change is seasonal.');
    if (rep.change) parts.push(`Change: NDVI ${rep.change.ndvi_change >= 0 ? '+' : ''}${rep.change.ndvi_change}, NDBI ${rep.change.ndbi_change >= 0 ? '+' : ''}${rep.change.ndbi_change}, NDWI ${rep.change.ndwi_change >= 0 ? '+' : ''}${rep.change.ndwi_change}, so ${rep.change.text}.`);
  } else {
    parts.push('No clear comparison scene was found for the period asked, so no change is claimed.');
  }
  if (/construction|structure|building|earthmov|new development/i.test(text)) parts.push('This measures surfaces, not objects: at 10 m it shows clearing and new hard surfaces, but cannot outline or count individual buildings.');
  parts.push('Index guide: NDVI above 0.6 is dense vegetation and below 0.2 is bare ground, water or pavement; NDBI above 0 points to built-up or bare surfaces; NDWI above 0 is open water.');
  return parts.join(' ');
}
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
  // Scene, construction and change questions, and anything naming
  // Sentinel-2, get a real Sentinel-2 scene with measured indexes.
  const sentinel = /sentinel|copernicus|esa\b/i.test(text ?? '');
  const useS2 = (kind === 'ndvi' && sentinel) || (kind === 'land' && (sentinel || /\bmonths?\b|\bweeks?\b/i.test(text))) || (!kind && !EVENT_RE.test(text ?? ''));
  if (useS2) {
    const asked = Number(firstUsableValue(params.radius_km, params.radius)) || radiusKmOf(text);
    const km = asked ? Math.min(Math.max(asked * 2, 1), 6) : (/construction|structure|building|site\b/i.test(text) ? 1 : 2);
    const w = sceneWindow(text);
    try {
      const rep = await cachedModis(`s2:${point.lat},${point.lon},${km},${w.after},${w.compareTo}`, () => sceneReport(point.lat, point.lon, { km, after: w.after, compareTo: w.compareTo }));
      if (rep?.latest?.indexes?.ndvi) {
        let summary = sceneSummary(point, rep, text, w.label);
        if (kind === 'land') {
          const lc = await cachedModis(`lc:${point.lat},${point.lon},5,null,null`, () => landCover(point.lat, point.lon, { km: 5 })).catch(() => null);
          if (lc) summary += ` Land cover context: ${landSummary(point, lc, '').replace(/^Land cover/, 'land cover')}`;
        }
        return res.json({
          status: 'ok', summary, answer: summary, confidence: 0.85,
          canonical: `satellite-imagery:s2:${rep.latest.id}`,
          latitude: point.lat, longitude: point.lon, place: point.place ?? null,
          scene_id: rep.latest.id, scene_datetime: rep.latest.datetime, cloud_cover_percent: rep.latest.cloud_cover,
          ndvi: rep.latest.indexes.ndvi?.mean ?? null, ndbi: rep.latest.indexes.ndbi?.mean ?? null, ndwi: rep.latest.indexes.ndwi?.mean ?? null,
          baseline_scene_id: rep.baseline?.id ?? null, baseline_datetime: rep.baseline?.datetime ?? null,
          change: rep.change, box_km: rep.box_km,
          product: 'Sentinel-2 L2A', source: S2_SOURCE, checked_at: new Date().toISOString(),
        });
      }
    } catch {
      // Planetary Computer down or slow: fall through to MODIS or the event answer.
    }
  }
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
  // A dated event question ("around 2025-09-26") searches that window,
  // closed events included, instead of only what is open today.
  const asked = datesIn(text)[0]?.at ?? null;
  const fmtDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const eonetUrl = asked
    ? `https://eonet.gsfc.nasa.gov/api/v3/events?status=all&start=${fmtDay(asked - 15 * 86400e3)}&end=${fmtDay(asked + 15 * 86400e3)}&limit=500`
    : 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&limit=200';
  try {
    events = (await getJson(eonetUrl, { timeoutMs: 15000 })).events ?? [];
  } catch (err) {
    return upstreamDown(res, 'The NASA event source', err);
  }
  const near = nearbyEvents(events, point, radius);
  const imageDate = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
  const windowText = asked ? `between ${fmtDay(asked - 15 * 86400e3)} and ${fmtDay(asked + 15 * 86400e3)}` : 'in the last 30 days';
  const lead = near.length
    ? `${near.length} NASA-tracked natural event${near.length > 1 ? 's' : ''} within ${radius} km ${windowText}: ${near.slice(0, 3).map((e) => `${e.title} (${e.category}, ${e.distance_km} km, last seen ${String(e.last_seen).slice(0, 10)})`).join('; ')}.`
    : `No NASA-tracked natural events (wildfire, storm, flood, volcano) within ${radius} km ${windowText}. NASA EONET lists larger events only, so a local flood can still have happened without an entry.`;
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
