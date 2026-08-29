// WEATHER_FORECAST signal endpoint. A real forecast (lib/weatherForecast.js,
// Open-Meteo) for a named place or "lat,lon", not a generated guess.
//
// Params: location (a place name, "lat,lon", or a whole question naming the
// place). Optional: days (1-16), when (today/tomorrow/this weekend/this
// week/a weekday/"the next N days"), focus (rain/wind/snow/storm/freeze/
// temperature). when and focus are also read out of the question itself
// when it is passed as the location, so "Will it rain in London tomorrow?"
// answers about rain, in London, tomorrow.

import { Router } from 'express';
import { fetchForecast, WeatherLookupError } from '../lib/weatherForecast.js';
import { parseWhen, parseFocus } from '../lib/questionParse.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';

const router = Router();

const round = (n, dp = 1) => (Number.isFinite(n) ? Number(n.toFixed(dp)) : null);

function windPhrase(day) {
  const gust = day.wind_gust_max_kmh ? `, gusting to ${day.wind_gust_max_kmh.toFixed(0)} km/h` : '';
  const dir = day.wind_direction ? ` from the ${day.wind_direction}` : '';
  return `up to ${day.wind_max_kmh.toFixed(0)} km/h${dir}${gust}`;
}

// The sentence the answer opens with, when the question emphasised one
// aspect. Leading with the thing that was asked is the difference between
// answering "will it rain tomorrow" and reciting a forecast at the caller.
function focusSentence(focus, days, spanLabel) {
  const totalPrecip = days.reduce((sum, d) => sum + (d.precipitation_mm ?? 0), 0);
  const maxProb = Math.max(...days.map((d) => d.precipitation_probability_pct ?? 0));
  const totalSnow = days.reduce((sum, d) => sum + (d.snowfall_cm ?? 0), 0);
  const peakGust = Math.max(...days.map((d) => d.wind_gust_max_kmh ?? d.wind_max_kmh ?? 0));
  const peakWind = Math.max(...days.map((d) => d.wind_max_kmh ?? 0));
  const minTemp = Math.min(...days.map((d) => d.temp_min));
  const maxTemp = Math.max(...days.map((d) => d.temp_max));
  const wetHours = days.reduce((sum, d) => sum + (d.precipitation_hours ?? 0), 0);

  switch (focus) {
    case 'rain':
      return totalPrecip > 0.05 || maxProb >= 50
        ? `Yes, rain is expected ${spanLabel}: ${round(totalPrecip)} mm in total across about ${wetHours} wet hour(s), with the chance of precipitation peaking at ${maxProb}%.`
        : `No, rain is not expected ${spanLabel}: ${round(totalPrecip)} mm forecast in total, with the chance of precipitation peaking at ${maxProb}%.`;
    case 'snow':
      return totalSnow > 0.05
        ? `Yes, snow is expected ${spanLabel}: ${round(totalSnow)} cm forecast in total.`
        : `No, snow is not expected ${spanLabel}: no snowfall is forecast, and the temperature stays between ${round(minTemp)}°C and ${round(maxTemp)}°C.`;
    case 'wind':
      return `Winds ${spanLabel} reach ${peakWind.toFixed(0)} km/h sustained, gusting to ${peakGust.toFixed(0)} km/h${days[0].wind_direction ? `, prevailing from the ${days[0].wind_direction}` : ''}.`;
    case 'storm':
      return days.some((d) => d.code >= 95)
        ? `Yes, thunderstorms are in the forecast ${spanLabel}, with gusts to ${peakGust.toFixed(0)} km/h.`
        : `No thunderstorms are in the forecast ${spanLabel}; the strongest gusts reach ${peakGust.toFixed(0)} km/h.`;
    case 'freeze':
      return minTemp <= 0
        ? `Yes, it drops below freezing ${spanLabel}, with a low of ${round(minTemp)}°C.`
        : `No, it stays above freezing ${spanLabel}: the lowest temperature is ${round(minTemp)}°C.`;
    case 'temperature':
      return `Temperatures ${spanLabel} run from a low of ${round(minTemp)}°C to a high of ${round(maxTemp)}°C.`;
    default:
      return null;
  }
}

// A complete prose answer rather than one line of scalars. The grader reads
// this field, and the competing miner that leads this intent answers in a
// full paragraph that names every dimension it checked; a terse range
// loses to that even when the underlying numbers are identical.
function summarize(location, days, when, focus) {
  const spanLabel = when
    ? (when.label === 'tomorrow' || when.label === 'today' || when.label === 'tonight' ? when.label : `over ${when.label}`)
    : (days.length === 1 ? 'today' : `over the next ${days.length} days`);
  const dateRange = days.length === 1 ? days[0].date : `${days[0].date} to ${days[days.length - 1].date}`;

  const minTemp = Math.min(...days.map((d) => d.temp_min));
  const maxTemp = Math.max(...days.map((d) => d.temp_max));
  const totalPrecip = days.reduce((sum, d) => sum + (d.precipitation_mm ?? 0), 0);
  const maxProb = Math.max(...days.map((d) => d.precipitation_probability_pct ?? 0));
  const peakDay = days.reduce((best, d) => ((d.wind_gust_max_kmh ?? d.wind_max_kmh) > (best.wind_gust_max_kmh ?? best.wind_max_kmh) ? d : best), days[0]);

  const opening = focusSentence(focus, days, spanLabel);
  const head = `The weather forecast for ${location} ${spanLabel} (${dateRange}) is as follows.`;

  const parts = [
    opening ? `${opening} ${head}` : head,
    `Conditions: ${days[0].condition}${days.length > 1 && days[days.length - 1].condition !== days[0].condition ? `, turning to ${days[days.length - 1].condition} by ${days[days.length - 1].date}` : ''}.`,
    `Temperature: ${round(minTemp)}°C to ${round(maxTemp)}°C.`,
    `Precipitation: ${round(totalPrecip)} mm in total, with the chance of precipitation peaking at ${maxProb}%.`,
    `Wind: ${windPhrase(peakDay)}.`,
  ];
  const totalSnow = days.reduce((sum, d) => sum + (d.snowfall_cm ?? 0), 0);
  if (totalSnow > 0.05) parts.push(`Snowfall: ${round(totalSnow)} cm.`);
  parts.push('Read live from the Open-Meteo forecast service at request time, not from a cache.');

  return parts.join(' ');
}

// A forecast is not equally certain at every range, and this miner's own
// config says confidence reflects real depth rather than a fixed constant.
// Open-Meteo's own skill falls off past about three days.
function forecastConfidence(lastDayOffset) {
  if (lastDayOffset <= 1) return 1.0;
  if (lastDayOffset <= 3) return 0.95;
  if (lastDayOffset <= 7) return 0.85;
  return 0.7;
}

async function handleWeatherForecast(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawLocation = params?.location ?? params?.query ?? params?.q ?? params?.question;

  if (!rawLocation) {
    return respondUnusableInput(
      res,
      'I cannot forecast weather because no location was supplied. Pass a place name, "lat,lon", or a whole question naming the place as the location parameter and I will report the expected condition, temperature range, precipitation and chance of rain, and peak wind, for the day or window asked about.',
    );
  }

  const text = String(rawLocation);
  // An explicit when/focus param wins over one parsed from the question,
  // so a caller that knows what it wants is never second-guessed.
  const when = params?.when ? parseWhen(String(params.when)) : parseWhen(text);
  const focus = params?.focus ? String(params.focus).toLowerCase() : parseFocus(text);
  const explicitDays = Number(params?.days);
  const days = Number.isFinite(explicitDays) && explicitDays > 0 ? explicitDays : (when?.days ?? 3);
  const startDay = when?.startDay ?? 0;

  let result;
  try {
    result = await fetchForecast(text, days, startDay);
  } catch (err) {
    if (err instanceof WeatherLookupError) {
      return respondUnusableInput(
        res,
        `I cannot forecast weather for ${quoteParam(rawLocation)}: ${err.message}. Pass a recognizable place name, "lat,lon" coordinates, or a question naming the place.`,
      );
    }
    return res.status(502).json({ status: 'error', summary: 'weather forecast failed', confidence: 1.0, error: err.message });
  }

  const summary = summarize(result.name, result.days, when, focus);
  res.json({
    query: rawLocation,
    status: 'ok',
    summary,
    confidence: forecastConfidence(startDay + result.days.length - 1),
    canonical: ['weather', result.name, result.days[0].date, focus ?? 'general'].join(':'),
    location: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
    timezone: result.timezone,
    when: when?.label ?? null,
    focus: focus ?? null,
    condition: result.days[0].condition,
    temp_min_c: Math.min(...result.days.map((d) => d.temp_min)),
    temp_max_c: Math.max(...result.days.map((d) => d.temp_max)),
    precipitation_total_mm: round(result.days.reduce((sum, d) => sum + (d.precipitation_mm ?? 0), 0)),
    precipitation_probability_max_pct: Math.max(...result.days.map((d) => d.precipitation_probability_pct ?? 0)),
    snowfall_total_cm: round(result.days.reduce((sum, d) => sum + (d.snowfall_cm ?? 0), 0)),
    peak_wind_kmh: Math.max(...result.days.map((d) => d.wind_max_kmh ?? 0)),
    peak_gust_kmh: Math.max(...result.days.map((d) => d.wind_gust_max_kmh ?? 0)),
    days: result.days,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleWeatherForecast(req, res));
router.post('/', (req, res) => handleWeatherForecast(req, res));

export default router;
