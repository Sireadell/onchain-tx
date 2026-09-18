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

const router = Router();

const LOCATION_PARAM_KEYS = ['location', 'place', 'city'];
const DATE_PARAM_KEYS = ['date', 'day', 'on_date'];
const FREE_TEXT_KEYS = ['query', 'q', 'question', 'text', 'input'];

const MAX_INPUT_CHARS = 400;

// Pulls a YYYY-MM-DD date out of free text, or an ISO-ish variant with
// slashes. Also recognises "today"/"yesterday" as relative words, since a
// caller who says "today" for a verification intent almost always means
// yesterday was fine but today has no archive yet; that ambiguity is
// resolved honestly downstream rather than guessed at here.
function extractDate(text) {
  if (typeof text !== 'string') return null;
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

async function handleWeatherForecastVerify(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  const locationRaw = firstUsableValue(...LOCATION_PARAM_KEYS.map((k) => params[k]));
  const dateRaw = firstUsableValue(...DATE_PARAM_KEYS.map((k) => params[k]));
  const freeText = firstUsableValue(...FREE_TEXT_KEYS.map((k) => params[k]));

  const locationInput = String(locationRaw ?? freeText ?? '').trim().slice(0, MAX_INPUT_CHARS);
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

  let result;
  try {
    result = await fetchHistoricalConditions(locationInput, dateStr);
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

  res.json({
    status: 'ok',
    summary: summarize(result, dateStr),
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
