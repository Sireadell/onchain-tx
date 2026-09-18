// ROUTE_ETA signal endpoint. Given an origin and destination (place names or
// coordinates), returns driving distance and estimated travel time via OSRM
// (lib/routing.js). Place names are geocoded with weatherForecast.js's
// resolveCurrentLocation, reused rather than re-implemented, since it
// already ranks a geocoder's results the way a person means them ("Houston"
// -> Houston, Texas, not a fuzzy near-match). Params seen on competing
// miners in the live registry (2026-09-17): coords (OSRM's own
// "lon1,lat1;lon2,lat2" form, route-osrm-* miners), plus origin/destination
// as this route documents them.

import { Router } from 'express';
import {
  fetchRoute, RoutingLookupError, RoutingUpstreamError, OSRM_ATTRIBUTION, SUPPORTED_PROFILES,
} from '../lib/routing.js';
import { resolveCurrentLocation, WeatherLookupError, WeatherUpstreamError } from '../lib/weatherForecast.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';
import { parseCoordinates } from '../lib/questionParse.js';

const router = Router();

const ORIGIN_KEYS = ['origin', 'from', 'start', 'source'];
const DESTINATION_KEYS = ['destination', 'to', 'end', 'target'];
const MODE_KEYS = ['mode', 'profile', 'travel_mode'];
const QUESTION_KEYS = ['question', 'query', 'q', 'text', 'input'];
const MAX_INPUT_CHARS = 300;

const MODE_ALIASES = {
  driving: 'driving', drive: 'driving', car: 'driving', vehicle: 'driving',
  walking: 'walking', walk: 'walking', foot: 'walking', pedestrian: 'walking',
  cycling: 'cycling', cycle: 'cycling', bike: 'cycling', bicycle: 'cycling',
};

// No mode supplied at all defaults to driving silently, the ordinary case.
// A mode that WAS supplied but does not match any known alias (found live,
// 2026-09-17: mode=teleport) must come back as null, not silently become
// "driving" too, or the "other modes are refused honestly" promise this
// endpoint's own miner.yaml entry makes is simply false.
function normalizeMode(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'driving';
  return MODE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

// OSRM's own "coords" form, semicolon-separated "lon,lat" pairs, used by
// several competing miners as their sole parameter.
function parseCoordsParam(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(';').map((s) => s.trim());
  if (parts.length !== 2) return null;
  const points = parts.map((p) => {
    const [lon, lat] = p.split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { latitude: lat, longitude: lon } : null;
  });
  return points[0] && points[1] ? { origin: points[0], destination: points[1] } : null;
}

// "from London to Paris", "how far is it from Miami to Orlando", pulls an
// origin/destination pair out of a whole question when neither structured
// param arrived.
const FROM_TO_RE = /\bfrom\s+(.+?)\s+to\s+(.+?)(?:[?.!]|$)/i;
const BETWEEN_RE = /\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!]|$)/i;
// "how far is Seattle from Portland (by car)?", the destination-first
// phrasing FROM_TO_RE cannot match (there is no "to" in it at all). Found
// live 2026-09-17: this exact phrasing was refused for want of an
// origin/destination pair the other two patterns could not see. Order
// barely matters for a distance/ETA answer, so the two places found are
// just labeled destination-then-origin in reading order.
const IS_FROM_RE = /\bis\s+(.+?)\s+from\s+(.+?)(?:\s+by\s+\w+)?(?:[?.!]|$)/i;

function extractPairFromQuestion(text) {
  const fromTo = text.match(FROM_TO_RE);
  if (fromTo) return { origin: fromTo[1].trim(), destination: fromTo[2].trim() };
  const between = text.match(BETWEEN_RE);
  if (between) return { origin: between[1].trim(), destination: between[2].trim() };
  const isFrom = text.match(IS_FROM_RE);
  if (isFrom) return { origin: isFrom[2].trim(), destination: isFrom[1].trim() };
  return null;
}

async function resolvePoint(value) {
  const coords = parseCoordinates(value);
  if (coords) return { name: `${coords.latitude}, ${coords.longitude}`, latitude: coords.latitude, longitude: coords.longitude };
  return resolveCurrentLocation(value);
}

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins} minutes`;
}

function summarize(originName, destName, route) {
  const timeText = formatDuration(route.duration_min);
  const base = `Driving from ${originName} to ${destName} is approximately ${route.distance_km} km and takes about ${timeText} under normal conditions.`;
  if (!route.ferry) return base;
  // Honest, not a guess: OSRM's own step data named a real ferry crossing
  // (see lib/routing.js). Reporting the bare total as an ordinary driving
  // time would be true of that one specific route and misleading about what
  // "how long to drive" usually means when land connects the two places by
  // a shorter route this server does not model (a tunnel, a shuttle train).
  const ferryTime = formatDuration(route.ferry.duration_s / 60);
  const via = route.ferry.names.length ? ` via ${route.ferry.names.join(', ')}` : '';
  return `${base} This route includes a ferry crossing${via} of about ${ferryTime}, so a faster way to travel between these places may exist that this service does not cover.`;
}

async function handleRouteEta(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  const coordsRaw = params.coords;
  const originRaw = firstUsableValue(...ORIGIN_KEYS.map((k) => params[k]));
  const destinationRaw = firstUsableValue(...DESTINATION_KEYS.map((k) => params[k]));
  const modeRaw = firstUsableValue(...MODE_KEYS.map((k) => params[k]));
  const questionRaw = firstUsableValue(...QUESTION_KEYS.map((k) => params[k]));

  const mode = normalizeMode(modeRaw);

  let originText = typeof originRaw === 'string' ? originRaw.trim().slice(0, MAX_INPUT_CHARS) : null;
  let destinationText = typeof destinationRaw === 'string' ? destinationRaw.trim().slice(0, MAX_INPUT_CHARS) : null;
  let directCoords = typeof coordsRaw === 'string' ? parseCoordsParam(coordsRaw) : null;

  if (!directCoords && (!originText || !destinationText) && typeof questionRaw === 'string' && questionRaw.trim()) {
    const derived = extractPairFromQuestion(questionRaw.slice(0, MAX_INPUT_CHARS));
    if (derived) {
      originText = originText ?? derived.origin;
      destinationText = destinationText ?? derived.destination;
    }
  }

  if (!directCoords && (!originText || !destinationText)) {
    return respondUnusableInput(
      res,
      'I cannot estimate a travel time because I need both an origin and a destination. Pass origin and destination as place names or "lat,lon" pairs, e.g. origin=London, destination=Paris.',
    );
  }

  if (mode === null || (mode !== 'driving' && !SUPPORTED_PROFILES.has(mode))) {
    return respondUnusableInput(
      res,
      `The public routing server this endpoint uses only reliably supports driving directions, not ${quoteParam(modeRaw)}. Ask for a driving ETA instead, or expect this to be a driving-time estimate.`,
    );
  }

  let originPoint;
  let destinationPoint;
  try {
    if (directCoords) {
      originPoint = { name: `${directCoords.origin.latitude}, ${directCoords.origin.longitude}`, ...directCoords.origin };
      destinationPoint = { name: `${directCoords.destination.latitude}, ${directCoords.destination.longitude}`, ...directCoords.destination };
    } else {
      [originPoint, destinationPoint] = await Promise.all([
        resolvePoint(originText),
        resolvePoint(destinationText),
      ]);
    }
  } catch (err) {
    if (err instanceof WeatherLookupError) {
      return respondUnusableInput(res, `I could not resolve one of the locations to coordinates: ${err.message}.`);
    }
    if (err instanceof WeatherUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: 'The location lookup service is temporarily unavailable, so I could not resolve these places to coordinates. Retry shortly.',
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  let route;
  try {
    route = await fetchRoute(originPoint, destinationPoint, 'driving');
  } catch (err) {
    if (err instanceof RoutingLookupError) {
      return respondUnusableInput(res, err.message);
    }
    if (err instanceof RoutingUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: `The public routing server is temporarily unavailable or rate-limited for a route from ${originPoint.name} to ${destinationPoint.name}. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  res.json({
    status: 'ok',
    summary: summarize(originPoint.name, destinationPoint.name, route),
    // A route OSRM can only complete via a ferry it does not model
    // door-to-door timing for well (boarding, sailing schedule) is real data
    // but a shakier answer than a plain road trip, so it gets less
    // confidence than the default here, not the same 0.85 as an ordinary one.
    confidence: route.ferry ? 0.55 : 0.85,
    canonical: ['route-eta', originPoint.name, destinationPoint.name].join(':').toLowerCase().replace(/\s+/g, '-'),
    origin: originPoint.name,
    destination: destinationPoint.name,
    origin_coordinates: { latitude: originPoint.latitude, longitude: originPoint.longitude },
    destination_coordinates: { latitude: destinationPoint.latitude, longitude: destinationPoint.longitude },
    distance_km: route.distance_km,
    distance_m: route.distance_m,
    duration_minutes: route.duration_min,
    duration_seconds: route.duration_s,
    mode: 'driving',
    includes_ferry: Boolean(route.ferry),
    ferry: route.ferry,
    source: 'OSRM (router.project-osrm.org)',
    attribution: OSRM_ATTRIBUTION,
    checked_at: route.fetchedAt,
  });
}

router.get('/', (req, res) => handleRouteEta(req, res));
router.post('/', (req, res) => handleRouteEta(req, res));

export default router;
