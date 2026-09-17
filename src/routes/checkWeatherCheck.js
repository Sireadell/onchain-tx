// WEATHER_CHECK signal endpoint. Conditions right now (lib/weatherForecast.js
// #fetchCurrentConditions, Open-Meteo), not a multi-day forecast, for
// "what's it like in X right now" rather than "will it rain tomorrow".
//
// Params: location (a place name, "lat,lon", or a whole question naming the
// place). The engine sends whichever name the competing miners on this
// intent declare (live registry 2026-09-16: q on six of them, lat/lon on
// nine, latitude/longitude on six, location, query, question, city, place),
// so all of those are read. Replayed before this change, city=Tokyo,
// place=Tokyo and latitude/longitude pairs were all refused as "no
// location supplied".

import { Router } from 'express';
import {
  fetchCurrentConditions, resolveCurrentLocation, WeatherLookupError, WeatherUpstreamError,
} from '../lib/weatherForecast.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { questionMatchesIntent, WEATHER_CUES } from '../lib/intentGuard.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const round = (n, dp = 1) => (Number.isFinite(n) ? Number(n.toFixed(dp)) : null);
const toF = (c) => (Number.isFinite(c) ? round(c * 9 / 5 + 32) : null);

// A value longer than this is a passage, not a place; only the head is
// read so an oversized value costs the same as a short one.
const MAX_LOCATION_CHARS = 300;

const PLACE_KEYS = ['location', 'city', 'place', 'name', 'q', 'query', 'question', 'text', 'input'];

// Questions on this intent are mostly "is there a warning / alert /
// storm watch for X right now". The reading is what is served either way,
// with one extra sentence saying whether it shows severe weather, so the
// answer speaks to the question rather than ignoring it.
const ALERT_QUESTION_RE = /\b(?:warning|warnings|alert|alerts|advisory|advisories|watch|emergency|severe|storm|storms|flood|flooding|hurricane|cyclone|typhoon|tornado)\b/i;
const SEVERE_CODES = new Set([65, 67, 75, 82, 86, 95, 96, 99]);
const GALE_KMH = 62;
const HEAVY_RAIN_MM = 10;

function coordinatePair(params) {
  const lat = firstUsableValue(params?.lat, params?.latitude);
  const lon = firstUsableValue(params?.lon, params?.lng, params?.long, params?.longitude);
  if (lat == null || lon == null) return null;
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return `${latitude},${longitude}`;
}

function severeNote(result) {
  const reasons = [];
  if (SEVERE_CODES.has(result.code)) reasons.push(result.condition);
  if (Number.isFinite(result.wind_speed_kmh) && result.wind_speed_kmh >= GALE_KMH) reasons.push(`gale-force wind of ${round(result.wind_speed_kmh)} km/h`);
  if (Number.isFinite(result.precipitation_mm) && result.precipitation_mm >= HEAVY_RAIN_MM) reasons.push(`heavy precipitation of ${round(result.precipitation_mm)} mm in the last hour`);
  if (reasons.length) {
    return `The live reading shows severe weather right now: ${reasons.join(', ')}. Official government alerts are not carried in this reading, so check the national weather service for any formal warning.`;
  }
  return 'The live reading shows no severe weather right now (no thunderstorm, heavy rain, snow or gale-force wind). Official government alerts are not carried in this reading.';
}

function summarize(result, { alertQuestion }) {
  const temp = round(result.temperature_c);
  const parts = [
    `Right now in ${result.name} it is ${temp}°C (${toF(result.temperature_c)}°F) and ${result.condition}`
      + `${result.apparent_temperature_c != null ? `, feels like ${round(result.apparent_temperature_c)}°C` : ''}.`,
  ];
  const detail = [];
  if (result.humidity_pct != null) detail.push(`humidity ${round(result.humidity_pct, 0)}%`);
  if (result.wind_speed_kmh != null) detail.push(`wind ${round(result.wind_speed_kmh)} km/h${result.wind_direction ? ` from the ${result.wind_direction}` : ''}`);
  if (result.precipitation_mm != null) detail.push(`precipitation ${round(result.precipitation_mm)} mm`);
  if (result.cloud_cover_pct != null) detail.push(`cloud cover ${round(result.cloud_cover_pct, 0)}%`);
  if (detail.length) parts.push(`${detail.join(', ').replace(/^./, (c) => c.toUpperCase())}.`);
  if (result.observed_at) {
    const when = result.observed_at_utc
      ? `${result.observed_at} local time (${result.observed_at_utc.replace('T', ' ').replace('Z', ' UTC')})`
      : result.observed_at;
    parts.push(`Observed at ${when}.`);
  }
  if (result.region_asked) parts.push(`${result.region_asked} is a region, so this reading is for its main city.`);
  if (alertQuestion) parts.push(severeNote(result));
  if (result.degraded) parts.push(`Source: ${result.source} (fallback).`);
  return parts.join(' ');
}

async function handleWeatherCheck(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const coords = coordinatePair(params);
  const rawPlace = firstUsableValue(...PLACE_KEYS.map((k) => params?.[k]));
  const rawLocation = coords ?? rawPlace;

  if (!rawLocation) {
    return respondUnusableInput(
      res,
      'I cannot check current weather because no location was supplied. Pass a place name, "lat,lon", or a whole question naming the place as the location parameter and I will report the current condition, temperature, humidity, wind and precipitation.',
    );
  }

  const text = String(rawLocation).slice(0, MAX_LOCATION_CHARS);
  // The free-text question, when the place came in structured form: it
  // says what was asked (an alert, a temperature) and is the fallback
  // place source when the structured value names none.
  const questionText = [params?.question, params?.query, params?.q, params?.text]
    .find((value) => typeof value === 'string' && value.trim() && value.trim() !== text.trim()) ?? null;
  if (!coords && !questionMatchesIntent(text, WEATHER_CUES) && !(questionText && WEATHER_CUES.test(questionText))) {
    return respondUnusableInput(
      res,
      'This request does not appear to ask about weather. Ask for the current weather or conditions and name the location.',
    );
  }

  let result;
  try {
    let location;
    try {
      location = await resolveCurrentLocation(text);
    } catch (err) {
      if (!(err instanceof WeatherLookupError) || !questionText) throw err;
      location = await resolveCurrentLocation(questionText.slice(0, MAX_LOCATION_CHARS));
    }
    result = await fetchCurrentConditions(location);
  } catch (err) {
    if (err instanceof WeatherLookupError) {
      return respondUnusableInput(
        res,
        `I cannot check current weather for ${quoteParam(rawLocation)}: ${err.message}. Pass a recognizable place name, "lat,lon" coordinates, or a question naming the place.`,
      );
    }
    const upstream = err instanceof WeatherUpstreamError;
    return res.status(502).json({
      status: 'error',
      summary: upstream
        ? `The weather service is temporarily unavailable: ${err.message}. This is not a problem with the request; retry shortly.`
        : 'current weather check failed',
      confidence: 1.0,
      error: err.message,
    });
  }

  const alertQuestion = ALERT_QUESTION_RE.test(text) || (questionText ? ALERT_QUESTION_RE.test(questionText) : false);

  res.json({
    query: rawLocation,
    status: 'ok',
    summary: summarize(result, { alertQuestion }),
    confidence: result.degraded ? 0.85 : 1.0,
    canonical: ['weather-check', result.name, result.observed_at].join(':'),
    location: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
    timezone: result.timezone ?? null,
    condition: result.condition,
    weather_code: result.code ?? null,
    temperature_c: round(result.temperature_c),
    temperature_f: toF(result.temperature_c),
    apparent_temperature_c: round(result.apparent_temperature_c),
    humidity_pct: result.humidity_pct,
    wind_speed_kmh: round(result.wind_speed_kmh),
    wind_direction: result.wind_direction,
    precipitation_mm: round(result.precipitation_mm),
    cloud_cover_pct: result.cloud_cover_pct,
    severe_weather_now: SEVERE_CODES.has(result.code)
      || (Number.isFinite(result.wind_speed_kmh) && result.wind_speed_kmh >= GALE_KMH)
      || (Number.isFinite(result.precipitation_mm) && result.precipitation_mm >= HEAVY_RAIN_MM),
    observed_at: result.observed_at,
    observed_at_utc: result.observed_at_utc ?? null,
    source: result.source,
    ...(result.degraded ? { degraded: true, attribution: result.attribution } : {}),
    checked_at: result.fetchedAt,
  });
}

router.get('/', (req, res) => handleWeatherCheck(req, res));
router.post('/', (req, res) => handleWeatherCheck(req, res));

export default router;
