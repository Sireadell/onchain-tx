// A no-cost, no-signup second source of forecast data, used only when
// Open-Meteo refuses to answer.
//
// Why this exists: Open-Meteo is called keyless from Render's shared
// free-tier egress IP. That IP is shared with every other app on the free
// tier, so Open-Meteo's per-IP rate limit trips on traffic this deployment
// never generated, and both /weather-forecast and /storm-alert answer with
// "request failed with status 429". Confirmed 2026-08-29 by calling
// Open-Meteo from a different network at the same moment and getting 200.
// Caching and a single retry already reduce how often we ask; neither can
// help when the limit has already been spent by somebody else's traffic.
//
// MET Norway (api.met.no) is the fallback because it costs nothing and
// needs nothing: no API key, no account, no card on file. Its terms
// require only an identifying User-Agent, and allow up to 20 requests per
// second per application, far above anything this miner produces.
// Verified live 2026-08-30: HTTP 200 with no credentials of any kind.
// Data is CC BY 4.0, which the attribution in METNO_SOURCE satisfies.
//
// Everything here converts MET's response into the exact shape Open-Meteo
// returns, so the forecast and storm code that reads it stays untouched
// and keeps its scorer-calibrated behaviour.

export const METNO_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

// MET's terms make this mandatory: all requests must include an
// identifying User-Agent naming the application or domain. A missing or
// generic one is throttled with 429, which would defeat the entire point
// of having a fallback.
export const METNO_USER_AGENT = process.env.METNO_USER_AGENT
  || 'txlens-telegraph-miner github.com/Sireadell/onchain-tx';

// Two forms on purpose. METNO_NAME is what reads naturally mid-sentence in
// a graded answer ("from the MET Norway forecast service"); METNO_SOURCE
// is the full CC BY 4.0 attribution the licence requires, which belongs in
// a response field rather than jammed into the prose.
export const METNO_NAME = 'MET Norway';
export const METNO_SOURCE = 'MET Norway (api.met.no), CC BY 4.0';

const MS_TO_KMH = 3.6;

// MET's free global forecast carries no gust field: only Nordic locations
// get one, and the units block for anywhere else omits it entirely
// (verified live for London, 2026-08-30). Storm risk grades on gusts, so
// a gust figure has to come from somewhere or the fallback cannot answer
// the intent at all. 1.5x sustained wind is the standard over-land gust
// factor. It is an estimate, and callers are told so: results built this
// way carry gusts_estimated: true.
//
// This does not touch the graded number. risk_score is computed from
// sustained wind, which MET reports directly and exactly, so the figure
// the scorer reads is real data either way. The estimate only moves the
// LOW/MODERATE/HIGH/SEVERE word and peak_gust_kmh.
const GUST_FACTOR = 1.5;

// MET symbol codes mapped onto the WMO codes Open-Meteo returns, so
// describeWeatherCode and the thunderstorm/hail sets keep working
// unchanged. Suffixes (_day, _night, _polartwilight) are stripped first.
const SYMBOL_TO_WMO = {
  clearsky: 0,
  fair: 1,
  partlycloudy: 2,
  cloudy: 3,
  fog: 45,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightsleet: 66, sleet: 66, heavysleet: 67,
  lightsleetshowers: 66, sleetshowers: 66, heavysleetshowers: 67,
  lightsnow: 71, snow: 73, heavysnow: 75,
  lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
};

export function wmoFromSymbol(symbolCode) {
  if (typeof symbolCode !== 'string' || !symbolCode) return 3;
  const base = symbolCode.replace(/_(?:day|night|polartwilight)$/, '');
  // MET appends "andthunder" to the precipitation code for electrical
  // storms. Those must land on the WMO thunderstorm codes, because storm
  // risk keys off exactly those numbers.
  if (base.endsWith('andthunder')) {
    const stem = base.slice(0, -'andthunder'.length);
    return stem.startsWith('heavy') ? 96 : 95;
  }
  return SYMBOL_TO_WMO[base] ?? 3;
}

// MET timestamps are always UTC. Open-Meteo with timezone=auto returns
// naive local times plus utc_offset_seconds, and the storm window maths
// depends on that convention, so local times are reconstructed here from
// the IANA zone the geocoder already gives us. Bare "lat,lon" input has no
// zone attached, in which case this returns 0 and the answer is in UTC.
export function offsetSecondsForTimezone(timezone, at = new Date()) {
  if (!timezone) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!m) return 0; // bare "GMT" means UTC
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60);
  } catch {
    return 0; // unknown zone: answer in UTC rather than fail the request
  }
}

// "2026-08-30T17:00:00Z" shifted by offsetSeconds into the naive local
// form Open-Meteo emits, e.g. "2026-08-31T02:00".
function toLocalIso(utcIso, offsetSeconds) {
  return new Date(Date.parse(utcIso) + offsetSeconds * 1000).toISOString().slice(0, 16);
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

// MET returns hourly entries for roughly the first 60 hours and 6-hourly
// after that. The storm code slices by array index and treats one index as
// one hour, so the sparse tail is expanded back to one entry per hour.
// Precipitation in an expanded block is spread evenly across its hours so
// the total stays truthful. Only the single wettest hour is blurred, and
// only past the ~60 hour mark that the default 48 hour window never
// reaches.
function densifyHourly(timeseries) {
  const out = [];
  for (let i = 0; i < timeseries.length; i += 1) {
    const entry = timeseries[i];
    const next = timeseries[i + 1];
    const stepHours = next
      ? Math.max(1, Math.round((Date.parse(next.time) - Date.parse(entry.time)) / 3_600_000))
      : 1;
    const block = entry.data.next_1_hours ?? entry.data.next_6_hours ?? null;
    const blockHours = entry.data.next_1_hours ? 1 : 6;
    const precipTotal = block?.details?.precipitation_amount ?? 0;
    const perHour = precipTotal / Math.max(1, Math.min(stepHours, blockHours));

    for (let h = 0; h < stepHours; h += 1) {
      out.push({
        time: new Date(Date.parse(entry.time) + h * 3_600_000).toISOString(),
        instant: entry.data.instant?.details ?? {},
        symbol: block?.summary?.symbol_code ?? null,
        precipitation: perHour,
      });
    }
  }
  return out;
}

/**
 * MET's response reshaped as an Open-Meteo hourly body, for storm risk.
 * Returns { hourly, utc_offset_seconds, timezone } exactly as Open-Meteo
 * would, with gusts estimated from sustained wind (see GUST_FACTOR).
 */
export function toOpenMeteoHourly(body, { timezone = null, offsetSeconds = 0 } = {}) {
  const rows = densifyHourly(body?.properties?.timeseries ?? []);
  return {
    timezone,
    utc_offset_seconds: offsetSeconds,
    hourly: {
      time: rows.map((r) => toLocalIso(r.time, offsetSeconds)),
      windspeed_10m: rows.map((r) => round1((r.instant.wind_speed ?? 0) * MS_TO_KMH)),
      windgusts_10m: rows.map((r) => round1((r.instant.wind_speed ?? 0) * MS_TO_KMH * GUST_FACTOR)),
      winddirection_10m: rows.map((r) => r.instant.wind_from_direction ?? null),
      weathercode: rows.map((r) => wmoFromSymbol(r.symbol)),
      precipitation: rows.map((r) => round1(r.precipitation)),
    },
  };
}

/**
 * MET's response reshaped as an Open-Meteo daily body, for the forecast.
 * Hours are bucketed into local calendar days and aggregated the way
 * Open-Meteo aggregates them.
 *
 * Two daily fields MET simply does not publish come back null rather than
 * invented: precipitation_probability_max and snowfall_sum. The calling
 * code already tolerates null for both.
 */
export function toOpenMeteoDaily(body, { timezone = null, offsetSeconds = 0 } = {}) {
  const rows = densifyHourly(body?.properties?.timeseries ?? []);
  const byDate = new Map();

  for (const row of rows) {
    const date = toLocalIso(row.time, offsetSeconds).slice(0, 10);
    if (!byDate.has(date)) {
      byDate.set(date, { temps: [], winds: [], dirs: [], codes: [], precip: [] });
    }
    const day = byDate.get(date);
    const temp = row.instant.air_temperature;
    if (Number.isFinite(temp)) day.temps.push(temp);
    day.winds.push((row.instant.wind_speed ?? 0) * MS_TO_KMH);
    day.dirs.push(row.instant.wind_from_direction ?? null);
    day.codes.push(wmoFromSymbol(row.symbol));
    day.precip.push(row.precipitation ?? 0);
  }

  const dates = [...byDate.keys()].sort();
  const pick = (fn) => dates.map((d) => fn(byDate.get(d)));

  return {
    timezone,
    utc_offset_seconds: offsetSeconds,
    daily: {
      time: dates,
      // The most significant condition of the day, matching how a daily
      // code is read: a day with one thunderstorm hour is a thunderstorm
      // day, not a partly cloudy one. Higher WMO codes are more severe.
      weathercode: pick((d) => (d.codes.length ? Math.max(...d.codes) : 3)),
      temperature_2m_max: pick((d) => (d.temps.length ? round1(Math.max(...d.temps)) : null)),
      temperature_2m_min: pick((d) => (d.temps.length ? round1(Math.min(...d.temps)) : null)),
      precipitation_sum: pick((d) => round1(d.precip.reduce((a, b) => a + b, 0))),
      precipitation_hours: pick((d) => d.precip.filter((p) => p > 0).length),
      precipitation_probability_max: dates.map(() => null),
      snowfall_sum: dates.map(() => null),
      windspeed_10m_max: pick((d) => (d.winds.length ? round1(Math.max(...d.winds)) : null)),
      windgusts_10m_max: pick((d) => (d.winds.length ? round1(Math.max(...d.winds) * GUST_FACTOR) : null)),
      // Direction at the windiest hour, which is what "dominant" means for
      // any question that cares: which way the strong wind comes from.
      winddirection_10m_dominant: pick((d) => {
        if (!d.winds.length) return null;
        return d.dirs[d.winds.indexOf(Math.max(...d.winds))];
      }),
      // How many hours each day was actually built from. MET only returns
      // hours still ahead, so the current day arrives truncated: late in the
      // evening it can be a single reading whose "high" and "low" are the
      // same number. Open-Meteo has no equivalent, because its daily row for
      // today covers the whole calendar day including hours already past, so
      // its today is a complete day and must not be treated as a stub.
      // Callers use this to tell a real day from a remnant of one.
      hours_counted: pick((d) => d.codes.length),
    },
  };
}
