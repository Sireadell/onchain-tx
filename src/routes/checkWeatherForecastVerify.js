// WEATHER_FORECAST_VERIFY signal endpoint. Given a place and a past date,
// reports what actually happened there via Open-Meteo's historical archive,
// distinct from WEATHER_FORECAST's forward-looking forecast. Real routed
// question seen live ("What is the 24-hour weather forecast for Auckland...
// starting today") is a forward-looking question that misrouted here; this
// endpoint honestly says it verifies past conditions and is not a forecast
// rather than fabricating one for today or the future.

import { Router } from 'express';
import {
  fetchHistoricalConditions, WeatherLookupError, WeatherUpstreamError,
} from '../lib/weatherForecast.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';
import {
  targetDate, ghcnStation, placeIn, coordsIn, readClaims, readTolerance, ghcnDay, era5Day, verdictAnswer,
} from '../lib/forecastVerify.js';
import { resolveLocation, fetchForecast } from '../lib/weatherForecast.js';

const router = Router();

const LOCATION_PARAM_KEYS = ['location', 'place', 'city'];
const DATE_PARAM_KEYS = ['date', 'day', 'on_date'];
const FREE_TEXT_KEYS = ['query', 'q', 'question', 'text', 'input'];

const MAX_INPUT_CHARS = 1200;

// Pulls a YYYY-MM-DD date out of free text, or an ISO-ish variant with
// slashes. Also recognises "today"/"yesterday" as relative words, since a
// caller who says "today" for a verification intent almost always means
// yesterday was fine but today has no archive yet; that ambiguity is
// resolved honestly downstream rather than guessed at here.
function extractDate(text) {
  if (typeof text !== 'string') return null;
  // The day being verified is the latest date named ("issued 23 September
  // for 24 September"), and dates may be written in words.
  const target = targetDate(text);
  if (target) return target;
  const iso = text.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (/\byesterday\b/i.test(text)) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (/\btoday\b/i.test(text)) {
    return new Date().toISOString().slice(0, 10);
  }
  return null;
}

function summarize(result, dateStr) {
  const parts = [];
  if (result.temp_min != null && result.temp_max != null) {
    parts.push(`On ${result.date} in ${result.name}, the recorded temperature ranged from ${result.temp_min}°C to ${result.temp_max}°C${result.condition ? ` with ${result.condition}` : ''}.`);
  } else {
    parts.push(`No complete historical record was found for ${result.name} on ${dateStr}.`);
  }
  if (result.precipitation_mm != null) parts.push(`Total precipitation was ${result.precipitation_mm}mm.`);
  parts.push('This reports what actually happened, verified against the historical record; it is not a forecast.');
  return parts.join(' ');
}

const fmtC = (v, f) => `${Math.round(v * 10) / 10} °C${f ? ` (${Math.round(v * 9 / 5 + 32)} °F)` : ''}`;

// A question that states a forecast (or names a weather station) is answered
// with the verdict first, then the observed figure and the error. Returns
// null when the question carries no claim to check, so the plain
// "what happened" answer below runs instead.
async function verifyClaim(text, dateStr) {
  const claims = readClaims(text);
  const station = ghcnStation(text);
  const hasClaim = Object.keys(claims.forecast).length > 0;
  if (!hasClaim && !station) return null;
  const tolerance = readTolerance(text);
  const place = placeIn(text);
  let observed = null;
  let placeName = place ?? text.slice(0, 60);
  if (station) {
    observed = await ghcnDay(station, dateStr).catch(() => null);
    if (observed) placeName = `${place ?? 'station'} (GHCN ${station})`;
  }
  if (!observed) {
    const needObs = ['max', 'min', 'precip'].some((k) => claims.forecast[k] !== undefined && claims.reference[k] === undefined);
    if (needObs || !hasClaim) {
      const loc = await resolveLocation(place ?? text).catch(() => (place ? resolveLocation(text) : null));
      if (!loc) return null;
      placeName = loc.name;
      observed = await era5Day(loc.latitude, loc.longitude, dateStr);
    }
  }
  const base = {
    status: 'ok', found: true, location: placeName, date: dateStr,
    source: observed?.source ?? 'values given in the question', checked_at: new Date().toISOString(),
  };
  if (hasClaim) {
    const v = verdictAnswer({ placeName, date: dateStr, claims, tolerance, observed });
    if (!v) return null;
    return {
      ...base, answer: v.answer, summary: v.answer, verdict: v.verdict, confidence: 0.9, checks: v.checks,
      observed_max_c: observed?.max ?? null, observed_min_c: observed?.min ?? null, observed_precip_mm: observed?.precip ?? null,
    };
  }
  if (!observed || observed.max == null) return null;
  const f = /fahrenheit|°\s*f/i.test(text);
  const answer = `On ${dateStr} at ${placeName}, the observed daily high (TMAX) was ${fmtC(observed.max, f)}${observed.min != null ? `, the low (TMIN) ${fmtC(observed.min, f)}` : ''}${observed.precip != null ? `, and precipitation ${observed.precip} mm` : ''}. Source: ${observed.source}.`;
  return {
    ...base, answer, summary: answer, verdict: 'found', confidence: 0.9,
    temp_max_c: observed.max, temp_min_c: observed.min, precipitation_mm: observed.precip,
  };
}

async function handleWeatherForecastVerify(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  const locationRaw = firstUsableValue(...LOCATION_PARAM_KEYS.map((k) => params[k]));
  const dateRaw = firstUsableValue(...DATE_PARAM_KEYS.map((k) => params[k]));
  const freeText = firstUsableValue(...FREE_TEXT_KEYS.map((k) => params[k]));

  // "at 51.5085,-0.1257" (no space) was not read as coordinates; found in a
  // scored question 2026-11-21.
  const locationInput = String(locationRaw ?? freeText ?? '').trim().slice(0, MAX_INPUT_CHARS)
    .replace(/(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, '$1, $2');
  if (!locationInput) {
    return respondUnusableInput(
      res,
      'I cannot verify past weather because no location was supplied. Pass a place name as the location parameter and a past date as the date parameter (YYYY-MM-DD).',
    );
  }

  let dateStr = dateRaw ? extractDate(String(dateRaw).slice(0, MAX_INPUT_CHARS)) ?? String(dateRaw).trim().slice(0, 40) : null;
  if (!dateStr && freeText) dateStr = extractDate(String(freeText).slice(0, MAX_INPUT_CHARS));
  // Found live 2026-09-18: a whole question with the date embedded in it
  // ("What was the actual weather in London on 2026-08-01?") arrived
  // entirely in the location field, with no separate date param, and this
  // fallback never ran because it only checked a dedicated free-text
  // field. locationInput itself is the whole question in that case, so it
  // is tried too, not just date/freeText.
  if (!dateStr) dateStr = extractDate(locationInput);
  // "What is the current weather forecast for Cairo, Egypt?" is routed here
  // too (4 scored questions 2026-11-21 to 11-23). It has no past day to
  // check, so it gets today's forecast plainly instead of a refusal.
  if (!dateStr && /\b(forecast|current|right now|today|tomorrow)\b/i.test(locationInput)) {
    const place = placeIn(locationInput);
    const fc = place ? await fetchForecast(place, 1).catch(() => null) : null;
    const d = fc?.days?.[0];
    if (d) {
      const answer = `Today's forecast for ${fc.name} (${d.date}) is ${d.condition ?? 'mixed conditions'}, with a high of ${d.temp_max} °C and a low of ${d.temp_min} °C, ${d.precipitation_probability_pct ?? 0}% chance of rain (${d.precipitation_mm} mm expected) and wind up to ${d.wind_max_kmh} km/h. Source: ${fc.source} forecast, read at request time.`;
      return res.json({
        status: 'ok', verdict: 'found', found: true, answer, summary: answer, confidence: 0.8,
        location: fc.name, date: d.date, temp_max_c: d.temp_max, temp_min_c: d.temp_min,
        precipitation_mm: d.precipitation_mm, source: fc.source, checked_at: new Date().toISOString(),
      });
    }
  }
  if (!dateStr) {
    return respondUnusableInput(
      res,
      `${quoteParam(locationInput)} was supplied but no past date was found to verify against. Pass a date parameter in YYYY-MM-DD form, e.g. 2026-08-01.`,
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return respondUnusableInput(
      res,
      `${quoteParam(dateStr)} is not a date in YYYY-MM-DD form, so past conditions cannot be verified for it.`,
    );
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  if (dateStr >= todayStr) {
    return respondUnusableInput(
      res,
      `${quoteParam(dateStr)} is today or in the future. This endpoint verifies what actually happened on a past date; it does not forecast. Use WEATHER_FORECAST for a future date.`,
    );
  }

  const verified = await verifyClaim(locationInput, dateStr).catch(() => null);
  if (verified) return res.json(verified);

  let result;
  try {
    result = await fetchHistoricalConditions(coordsIn(locationInput) ?? placeIn(locationInput) ?? locationInput, dateStr)
      .catch((err) => (placeIn(locationInput) ? fetchHistoricalConditions(locationInput, dateStr) : Promise.reject(err)));
  } catch (err) {
    if (err instanceof WeatherLookupError) {
      return respondUnusableInput(res, err.message);
    }
    if (err instanceof WeatherUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: 'The weather archive is temporarily unavailable, so past conditions could not be verified right now. Retry shortly.',
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  const plain = summarize(result, dateStr);
  res.json({
    status: 'ok',
    answer: plain,
    summary: plain,
    confidence: result.temp_min != null ? 0.85 : 0.5,
    canonical: ['weather-forecast-verify', result.name.toLowerCase(), dateStr].join(':'),
    location: result.name,
    date: result.date,
    temp_min_c: result.temp_min,
    temp_max_c: result.temp_max,
    condition: result.condition,
    precipitation_mm: result.precipitation_mm,
    wind_max_kmh: result.wind_max_kmh,
    source: result.source,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleWeatherForecastVerify(req, res));
router.post('/', (req, res) => handleWeatherForecastVerify(req, res));

export default router;
