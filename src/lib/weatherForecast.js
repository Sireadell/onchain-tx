// WEATHER_FORECAST signal — future conditions for a location, via
// Open-Meteo (no API key, no rate limit but our own). Two calls: geocode
// the place name to coordinates, then pull the daily forecast for those
// coordinates.

import { locationCandidates } from './questionParse.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CALL_TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS) || 8_000;

export class WeatherLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WeatherLookupError';
  }
}

// WMO weather codes (used by Open-Meteo) mapped to a plain-word condition.
const WEATHER_CODE_TEXT = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snow fall', 73: 'moderate snow fall', 75: 'heavy snow fall',
  77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};

export function describeWeatherCode(code) {
  return WEATHER_CODE_TEXT[code] ?? `unrecognized condition code ${code}`;
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new WeatherLookupError(`${label} request failed with status ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new WeatherLookupError(`${label} request timed out after ${CALL_TIMEOUT_MS}ms`);
    if (err instanceof WeatherLookupError) throw err;
    throw new WeatherLookupError(`${label} request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Resolves a place to coordinates. Takes a bare place name, a "lat,lon"
// pair, or a whole question naming a place ("Will it rain in London
// tomorrow?"). Question forms are handled by trying the candidate places
// questionParse pulls out, in order, and keeping the first that geocodes:
// a wrong guess costs one extra geocode call rather than a failed answer.
export async function resolveLocation(input) {
  const latLonMatch = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(input);
  if (latLonMatch) {
    return { name: input.trim(), latitude: Number(latLonMatch[1]), longitude: Number(latLonMatch[2]) };
  }

  const candidates = locationCandidates(input);
  if (candidates.length === 0) throw new WeatherLookupError(`no place name found in '${input}'`);

  for (const candidate of candidates) {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(candidate)}&count=1&format=json`;
    let body;
    try {
      body = await fetchJson(url, 'geocoding');
    } catch (err) {
      // A geocoder outage must not be reported as "no such place" — that
      // would blame the caller's input for our upstream being down.
      if (candidate === candidates[candidates.length - 1]) throw err;
      continue;
    }
    const hit = body?.results?.[0];
    if (!hit) continue;
    const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
    return { name: label, latitude: hit.latitude, longitude: hit.longitude };
  }
  throw new WeatherLookupError(`no location found matching '${input}'`);
}

// 16-point compass, so wind direction reads as a word rather than a
// bearing nobody wants to convert in their head.
const COMPASS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
export function compassDirection(degrees) {
  if (!Number.isFinite(degrees)) return null;
  return COMPASS[Math.round((degrees % 360) / 22.5) % 16];
}

// Returns { name, latitude, longitude, days: [...] } for `days` days
// starting `startDay` days from today, so "tomorrow" (startDay 1) and
// "Friday" answer about that day instead of a range beginning today.
// Precipitation probability, gusts and wind direction are included
// because the questions on this intent are mostly "will it rain" and
// "how windy", which a temperature range alone does not answer.
export async function fetchForecast(input, days = 3, startDay = 0) {
  const location = await resolveLocation(input);
  const span = Math.min(Math.max(days, 1), 16);
  const offset = Math.min(Math.max(startDay, 0), 15);
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    daily: 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,precipitation_hours,snowfall_sum,windspeed_10m_max,windgusts_10m_max,winddirection_10m_dominant',
    forecast_days: String(Math.min(offset + span, 16)),
    timezone: 'auto',
  });
  const body = await fetchJson(`${FORECAST_URL}?${params}`, 'forecast');
  const d = body.daily;
  if (!d?.time?.length) throw new WeatherLookupError(`no forecast data returned for '${input}'`);

  const daysOut = d.time.map((date, i) => ({
    date,
    code: d.weathercode[i],
    condition: describeWeatherCode(d.weathercode[i]),
    temp_min: d.temperature_2m_min[i],
    temp_max: d.temperature_2m_max[i],
    precipitation_mm: d.precipitation_sum[i],
    precipitation_probability_pct: d.precipitation_probability_max?.[i] ?? null,
    precipitation_hours: d.precipitation_hours?.[i] ?? null,
    snowfall_cm: d.snowfall_sum?.[i] ?? null,
    wind_max_kmh: d.windspeed_10m_max[i],
    wind_gust_max_kmh: d.windgusts_10m_max?.[i] ?? null,
    wind_direction: compassDirection(d.winddirection_10m_dominant?.[i]),
  })).slice(offset, offset + span);

  if (daysOut.length === 0) throw new WeatherLookupError(`the forecast does not reach that far ahead for '${input}'`);
  return { ...location, timezone: body.timezone ?? null, days: daysOut };
}

// Beaufort wind-force scale, by max gust speed in km/h. Used to grade
// disruption risk the same way a logistics/risk agent would read a
// storm bulletin: the category, not the raw number.
const BEAUFORT_THRESHOLDS_KMH = [
  [1, 0], [6, 1], [12, 2], [20, 3], [29, 4], [39, 5],
  [50, 6], [62, 7], [75, 8], [89, 9], [103, 10], [118, 11],
];
function beaufortForce(gustKmh) {
  let force = 12;
  for (const [threshold, f] of BEAUFORT_THRESHOLDS_KMH) {
    if (gustKmh < threshold) { force = f; break; }
  }
  return force;
}

const THUNDERSTORM_CODES = new Set([95, 96, 99]);
const SEVERE_HAIL_CODES = new Set([96, 99]);

// Returns a severe-weather disruption risk grade for a location over the
// next `hours` (default 48), based on peak wind gust (Beaufort force) and
// whether a thunderstorm is forecast in that window — not current
// conditions, and not a generic day-by-day forecast.
export async function fetchStormRisk(input, hours = 48) {
  const location = await resolveLocation(input);
  const span = Math.min(Math.max(hours, 1), 16 * 24);
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    hourly: 'windgusts_10m,windspeed_10m,winddirection_10m,weathercode,precipitation',
    // One day more than the window needs: the window starts at the current
    // hour, not at midnight, so it runs past the end of the last whole day.
    forecast_days: String(Math.min(Math.ceil(span / 24) + 1, 16)),
    timezone: 'auto',
  });
  const body = await fetchJson(`${FORECAST_URL}?${params}`, 'storm forecast');
  const h = body.hourly;
  if (!h?.time?.length) throw new WeatherLookupError(`no forecast data returned for '${input}'`);

  // Open-Meteo returns naive local timestamps under timezone=auto. Shifting
  // "now" by the same offset makes the comparison exact, so the window is
  // the next `hours` hours rather than `hours` hours from midnight — which
  // previously reported peak gusts that had already happened.
  const offsetMs = (body.utc_offset_seconds ?? 0) * 1000;
  const localNowIso = new Date(Date.now() + offsetMs).toISOString().slice(0, 13);
  let start = h.time.findIndex((t) => t.slice(0, 13) >= localNowIso);
  if (start < 0) start = 0;
  const end = Math.min(start + span, h.time.length);

  const at = (field) => h[field]?.slice(start, end) ?? [];
  const gusts = at('windgusts_10m');
  const speeds = at('windspeed_10m');
  const codes = at('weathercode');
  const precip = at('precipitation');
  if (gusts.length === 0) throw new WeatherLookupError(`no forecast hours available for '${input}'`);

  const peakGustKmh = Math.max(...gusts);
  const peakIndex = gusts.indexOf(peakGustKmh);
  const force = beaufortForce(peakGustKmh);
  const thunderstormHours = codes.filter((c) => THUNDERSTORM_CODES.has(c)).length;
  const severeHailHours = codes.filter((c) => SEVERE_HAIL_CODES.has(c)).length;

  let risk;
  if (severeHailHours > 0 || force >= 10) risk = 'SEVERE';
  else if (thunderstormHours > 0 || force >= 8) risk = 'HIGH';
  else if (force >= 6) risk = 'MODERATE';
  else risk = 'LOW';

  // A 0-1 score alongside the grade, for callers that want to threshold it
  // themselves (a smart contract cannot branch on the word "moderate").
  // Beaufort 12 is the top of the scale, so force/12 carries the wind, and
  // thunderstorms and hail each add a fixed amount rather than being folded
  // into the wind term, which would misreport a still-air electrical storm.
  const riskScore = Math.min(1, Number((force / 12 + (thunderstormHours > 0 ? 0.2 : 0) + (severeHailHours > 0 ? 0.2 : 0)).toFixed(2)));

  return {
    ...location,
    timezone: body.timezone ?? null,
    hours: gusts.length,
    window_start: h.time[start],
    window_end: h.time[end - 1],
    risk,
    risk_score: riskScore,
    peak_gust_kmh: peakGustKmh,
    peak_gust_time: h.time[start + peakIndex],
    max_wind_speed_kmh: speeds.length ? Math.max(...speeds) : null,
    wind_direction: compassDirection(h.winddirection_10m?.[start + peakIndex]),
    total_precipitation_mm: precip.length ? Number(precip.reduce((a, b) => a + (b ?? 0), 0).toFixed(1)) : null,
    beaufort_force: force,
    thunderstorm_hours: thunderstormHours,
    severe_hail_hours: severeHailHours,
  };
}
