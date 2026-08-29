// WEATHER_FORECAST signal — future conditions for a location, via
// Open-Meteo (no API key, no rate limit but our own). Two calls: geocode
// the place name to coordinates, then pull the daily forecast for those
// coordinates.

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

// Resolves a free-text place name or a "lat,lon" pair to coordinates.
export async function resolveLocation(input) {
  const latLonMatch = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(input);
  if (latLonMatch) {
    return { name: input.trim(), latitude: Number(latLonMatch[1]), longitude: Number(latLonMatch[2]) };
  }
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(input)}&count=1&format=json`;
  const body = await fetchJson(url, 'geocoding');
  const hit = body?.results?.[0];
  if (!hit) throw new WeatherLookupError(`no location found matching '${input}'`);
  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
  return { name: label, latitude: hit.latitude, longitude: hit.longitude };
}

// Returns { name, latitude, longitude, days: [{ date, code, condition,
// temp_min, temp_max, precipitation_mm, wind_max_kmh }] } for `days` days
// starting today.
export async function fetchForecast(input, days = 3) {
  const location = await resolveLocation(input);
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    daily: 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max',
    forecast_days: String(Math.min(Math.max(days, 1), 16)),
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
    wind_max_kmh: d.windspeed_10m_max[i],
  }));

  return { ...location, days: daysOut };
}
