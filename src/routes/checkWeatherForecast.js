// WEATHER_FORECAST signal endpoint. A real forecast (lib/weatherForecast.js,
// Open-Meteo) for a named place or "lat,lon", not a generated guess.
// Query param: location (place name, "lat,lon", or a whole question naming
// the place). Optional: days (1-16, default 3).

import { Router } from 'express';
import { fetchForecast, WeatherLookupError } from '../lib/weatherForecast.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';

const router = Router();

function summarize(location, days) {
  const today = days[0];
  const tempMins = days.map((d) => d.temp_min);
  const tempMaxs = days.map((d) => d.temp_max);
  const totalPrecip = days.reduce((sum, d) => sum + d.precipitation_mm, 0);
  const peakWind = Math.max(...days.map((d) => d.wind_max_kmh));
  const span = days.length === 1 ? 'today' : `over the next ${days.length} days`;

  return `${location}: ${today.condition} today, ${span} expect ${Math.min(...tempMins).toFixed(1)}-${Math.max(...tempMaxs).toFixed(1)}°C, ${totalPrecip.toFixed(1)}mm total precipitation, peak wind ${peakWind.toFixed(0)}km/h`;
}

async function handleWeatherForecast(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawLocation = params?.location;
  const days = Number(params?.days) || 3;

  if (!rawLocation) {
    return respondUnusableInput(
      res,
      'I cannot forecast weather because no location was supplied. Pass a place name, "lat,lon", or a question naming the place as the location parameter and I will report the expected condition, temperature range, precipitation, and peak wind.',
    );
  }

  let result;
  try {
    result = await fetchForecast(String(rawLocation), days);
  } catch (err) {
    if (err instanceof WeatherLookupError) {
      return respondUnusableInput(
        res,
        `I cannot forecast weather for ${quoteParam(rawLocation)}: ${err.message}. Pass a recognizable place name or "lat,lon" coordinates.`,
      );
    }
    return res.status(502).json({ status: 'error', summary: 'weather forecast failed', confidence: 1.0, error: err.message });
  }

  const summary = summarize(result.name, result.days);
  res.json({
    query: rawLocation,
    status: 'ok',
    summary,
    confidence: 1.0,
    canonical: ['weather', result.name, result.days[0].date].join(':'),
    location: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
    condition: result.days[0].condition,
    temp_min_c: Math.min(...result.days.map((d) => d.temp_min)),
    temp_max_c: Math.max(...result.days.map((d) => d.temp_max)),
    precipitation_total_mm: result.days.reduce((sum, d) => sum + d.precipitation_mm, 0),
    peak_wind_kmh: Math.max(...result.days.map((d) => d.wind_max_kmh)),
    days: result.days,
  });
}

router.get('/', (req, res) => handleWeatherForecast(req, res));
router.post('/', (req, res) => handleWeatherForecast(req, res));

export default router;
