// Second-choice forecast source, tried after Open-Meteo and before MET
// Norway. Added 2026-08-31: Open-Meteo's own precipitation-probability
// field is the one thing MET Norway can never supply outside the Nordics
// (see metnoFallback.js), and Render's shared egress IP was found stuck on
// the MET Norway path for extended stretches, silently dropping the
// "chance of precipitation peaking at X%" clause from every graded answer.
// OpenWeatherMap's free 5-day/3-hour endpoint carries a real `pop` field
// (0-1 probability of precipitation) worldwide, so it fills exactly that
// gap and only that gap — reshaped into the same Open-Meteo daily/hourly
// body shape the rest of this file already expects, same pattern as
// MET Norway's toOpenMeteoDaily/toOpenMeteoHourly.

const OWM_URL = 'https://api.openweathermap.org/data/2.5/forecast';

// The free 5-day endpoint's fixed resolution: one row per three hours.
const SLOT_HOURS = 3;

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

// OWM's condition codes are far finer-grained than Open-Meteo's WMO codes.
// Only the coarse bucket a downstream describeWeatherCode() call needs.
function wmoFromOwmId(id) {
  if (id == null) return 3;
  if (id >= 200 && id < 300) return 95;
  if (id >= 300 && id < 400) return 51;
  if (id === 511) return 66;
  if (id >= 500 && id < 505) return 63;
  if (id >= 520 && id < 532) return 80;
  if (id >= 600 && id < 700) return 73;
  if (id >= 700 && id < 800) return 45;
  if (id === 800) return 0;
  if (id === 801) return 1;
  if (id === 802) return 2;
  if (id >= 803 && id <= 804) return 3;
  return 3;
}

export function isOwmConfigured() {
  return Boolean(process.env.OPENWEATHERMAP_API_KEY);
}

async function fetchOwmRaw(latitude, longitude) {
  const key = process.env.OPENWEATHERMAP_API_KEY;
  const url = `${OWM_URL}?lat=${latitude}&lon=${longitude}&units=metric&appid=${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.WEATHER_TIMEOUT_MS) || 4_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`openweathermap request failed with status ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Buckets OWM's 3-hourly list into local calendar days, aggregated the way
// Open-Meteo aggregates its own daily rows (max/min/sum across the day's
// slots). Only reaches 5 days ahead — OWM's free tier's own limit — so
// this stays a fallback for the common near-term case, not a full
// replacement for Open-Meteo's 16-day range.
export async function fetchOwmDaily(location) {
  const body = await fetchOwmRaw(location.latitude, location.longitude);
  const offsetSeconds = body?.city?.timezone ?? 0;
  const byDate = new Map();

  for (const row of body.list ?? []) {
    const localMs = (row.dt + offsetSeconds) * 1000;
    const date = new Date(localMs).toISOString().slice(0, 10);
    if (!byDate.has(date)) {
      byDate.set(date, { tempsMax: [], tempsMin: [], winds: [], gusts: [], dirs: [], codes: [], rain: [], snow: [], pops: [] });
    }
    const day = byDate.get(date);
    if (Number.isFinite(row.main?.temp_max)) day.tempsMax.push(row.main.temp_max);
    if (Number.isFinite(row.main?.temp_min)) day.tempsMin.push(row.main.temp_min);
    const windKmh = (row.wind?.speed ?? 0) * 3.6;
    day.winds.push(windKmh);
    day.gusts.push((row.wind?.gust ?? row.wind?.speed ?? 0) * 3.6);
    if (Number.isFinite(row.wind?.deg)) day.dirs.push(row.wind.deg);
    day.codes.push(wmoFromOwmId(row.weather?.[0]?.id));
    day.rain.push(row.rain?.['3h'] ?? 0);
    day.snow.push(row.snow?.['3h'] ?? 0);
    if (Number.isFinite(row.pop)) day.pops.push(row.pop);
  }

  const dates = [...byDate.keys()].sort();
  const pick = (fn) => dates.map((d) => fn(byDate.get(d)));

  return {
    timezone: location.timezone ?? null,
    utc_offset_seconds: offsetSeconds,
    daily: {
      time: dates,
      weathercode: pick((d) => (d.codes.length ? Math.max(...d.codes) : 3)),
      temperature_2m_max: pick((d) => (d.tempsMax.length ? round1(Math.max(...d.tempsMax)) : null)),
      temperature_2m_min: pick((d) => (d.tempsMin.length ? round1(Math.min(...d.tempsMin)) : null)),
      precipitation_sum: pick((d) => round1(d.rain.reduce((a, b) => a + b, 0) + d.snow.reduce((a, b) => a + b, 0))),
      // One slot covers three hours. Counted per slot rather than once per
      // series, so a slot carrying both rain and snow is three hours of
      // precipitation and not six.
      precipitation_hours: pick((d) => d.rain.filter((mm, i) => mm + (d.snow[i] ?? 0) > 0).length * SLOT_HOURS),
      precipitation_probability_max: pick((d) => (d.pops.length ? Math.round(Math.max(...d.pops) * 100) : null)),
      snowfall_sum: pick((d) => round1(d.snow.reduce((a, b) => a + b, 0))),
      windspeed_10m_max: pick((d) => (d.winds.length ? round1(Math.max(...d.winds)) : null)),
      windgusts_10m_max: pick((d) => (d.gusts.length ? round1(Math.max(...d.gusts)) : null)),
      winddirection_10m_dominant: pick((d) => {
        if (!d.winds.length || !d.dirs.length) return null;
        return d.dirs[d.winds.indexOf(Math.max(...d.winds))] ?? d.dirs[0];
      }),
      // How many hours each day was actually built from, in the same units
      // as MET Norway's field of the same name, because weatherForecast.js
      // reads it to spot a today that is only a remnant of a day. OWM's
      // list starts at the next slot ahead, so late in the evening today
      // arrives as a single 3-hour slot whose "high" and "low" are the same
      // reading. Each slot is three hours.
      hours_counted: pick((d) => d.codes.length * SLOT_HOURS),
    },
  };
}

// The same list reshaped as an Open-Meteo hourly body, for /storm-alert.
// That route slices by array index and treats one index as one hour, so each
// 3-hour slot is expanded back into three rows, exactly as MET Norway's
// densifyHourly expands its 6-hourly tail.
//
// Wind and condition are the slot's own readings, repeated rather than
// interpolated: repeating preserves the peak gust OWM actually reported,
// where interpolating would smooth it down and understate the risk grade
// this route exists to give. Precipitation is a slot total, so it is divided
// across the three hours instead.
//
// One honest caveat: OWM stamps a slot with the time its accumulation ends,
// so attributing its rain to the three hours that follow shifts that figure
// forward by up to three hours. Over a 48-hour window read for peaks and
// hour counts that is immaterial, and it keeps rain aligned with the wind
// readings it is reported alongside.
export async function fetchOwmHourly(location) {
  const body = await fetchOwmRaw(location.latitude, location.longitude);
  const offsetSeconds = body?.city?.timezone ?? 0;
  const rows = [];

  for (const row of body.list ?? []) {
    const startMs = row.dt * 1000;
    const windKmh = round1((row.wind?.speed ?? 0) * 3.6);
    const gustKmh = round1((row.wind?.gust ?? row.wind?.speed ?? 0) * 3.6);
    const direction = Number.isFinite(row.wind?.deg) ? row.wind.deg : null;
    const code = wmoFromOwmId(row.weather?.[0]?.id);
    const slotPrecipMm = (row.rain?.['3h'] ?? 0) + (row.snow?.['3h'] ?? 0);
    const perHourMm = round1(slotPrecipMm / SLOT_HOURS);

    for (let h = 0; h < SLOT_HOURS; h += 1) {
      rows.push({
        // Naive local time, matching what Open-Meteo returns under
        // timezone=auto, because the storm window compares these strings
        // against a locally-shifted "now".
        time: new Date(startMs + h * 3_600_000 + offsetSeconds * 1000).toISOString().slice(0, 16),
        windspeed: windKmh,
        gust: gustKmh,
        direction,
        code,
        precipitation: perHourMm,
      });
    }
  }

  return {
    timezone: location.timezone ?? null,
    utc_offset_seconds: offsetSeconds,
    hourly: {
      time: rows.map((r) => r.time),
      windspeed_10m: rows.map((r) => r.windspeed),
      windgusts_10m: rows.map((r) => r.gust),
      winddirection_10m: rows.map((r) => r.direction),
      weathercode: rows.map((r) => r.code),
      precipitation: rows.map((r) => r.precipitation),
    },
  };
}
