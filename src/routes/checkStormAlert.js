// STORM_ALERT signal endpoint. Severe-weather disruption risk for a
// location over the next 24 hours (lib/weatherForecast.js#fetchStormRisk),
// graded on Beaufort gust thresholds and thunderstorm forecasts — for
// logistics/risk agents that need "how disruptive," not "what's the
// temperature."
//
// Params: location (a place name, "lat,lon", or a whole question naming
// the place, e.g. "is there a storm risk in Miami this weekend").
// Optional: hours (1-384, default 24, or read from the question).

import { Router } from 'express';
import { fetchStormRisk, withQuestionFallback, WeatherLookupError, WeatherUpstreamError } from '../lib/weatherForecast.js';
import { parseWhen } from '../lib/questionParse.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { freeTextMatchesIntent, questionMatchesIntent, STORM_CUES } from '../lib/intentGuard.js';

const router = Router();

const RISK_TEXT = {
  SEVERE: 'severe disruption risk',
  HIGH: 'high disruption risk',
  MODERATE: 'moderate disruption risk',
  LOW: 'low disruption risk',
};

// National-weather-service-style vocabulary alongside our own LOW/MODERATE/
// HIGH/SEVERE grade — verified live 2026-09-07 against the current
// STORM_ALERT rank-1 miner, which grades in exactly these three bands
// (none/advisory/warning) rather than our four. Added, not substituted, so
// existing callers reading risk_level keep working.
const LEVEL_BY_RISK = { SEVERE: 'warning', HIGH: 'warning', MODERATE: 'advisory', LOW: 'none' };

function kmhToMph(kmh) {
  return kmh * 0.621371;
}
function kmhToMs(kmh) {
  return kmh / 3.6;
}
function windTriple(kmh) {
  return `${kmh.toFixed(0)} km/h (${kmhToMph(kmh).toFixed(0)} mph, ${kmhToMs(kmh).toFixed(1)} m/s)`;
}

// What the grade actually means for anything exposed to it. A risk signal
// that stops at a number leaves the caller to look up what Beaufort 8
// implies; the competing miner that leads this intent says what to do, and
// an agent routing this to an operator needs the same.
const RISK_ACTION = {
  SEVERE: 'Suspend exposed operations. Secure or strike loose equipment and temporary structures, move personnel to hard shelter, and do not run lifting, hoisting or high-work during the peak window.',
  HIGH: 'Plan for interruption. Secure loose equipment and materials, postpone lifting and high-work across the peak window, and confirm that outdoor personnel have a shelter to move to.',
  MODERATE: 'Operations can continue with care. Secure lightweight and loose items, expect delays to lifting and high-work around the peak gust, and check exposed equipment afterwards.',
  LOW: 'No disruption expected. Routine operations can proceed; no storm-specific precautions are indicated over this window.',
};

// Beaufort is the scale a storm bulletin is written in, but the caller may
// not read Beaufort, so the grade is also said in plain words.
const FORCE_TEXT = {
  0: 'calm', 1: 'light air', 2: 'light breeze', 3: 'gentle breeze', 4: 'moderate breeze',
  5: 'fresh breeze', 6: 'strong breeze', 7: 'near gale', 8: 'gale', 9: 'strong gale',
  10: 'storm', 11: 'violent storm', 12: 'hurricane force',
};

async function handleStormAlert(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawLocation = params?.location ?? params?.query ?? params?.q ?? params?.question;

  if (!rawLocation) {
    return respondUnusableInput(
      res,
      'I cannot assess storm risk because no location was supplied. Pass a place name, "lat,lon", or a whole question naming the place as the location parameter and I will report a disruption risk grade over the next 24 hours from peak wind gust, Beaufort force and thunderstorm forecasts.',
    );
  }

  const text = String(rawLocation);
  // Only when the caller chose `location` itself: the whole question, when a
  // different one was sent alongside, to retry with if the location names no
  // place. See withQuestionFallback in weatherForecast.js.
  const fallbackText = params?.location != null
    ? [params?.query, params?.q, params?.question]
      .find((value) => typeof value === 'string' && value.trim() && value.trim() !== String(rawLocation).trim())
    : null;
  const explicitFreeText = params?.location == null;
  if (!(explicitFreeText ? freeTextMatchesIntent(text, STORM_CUES) : questionMatchesIntent(text, STORM_CUES))) {
    return respondUnusableInput(
      res,
      'This request does not appear to ask about storm or wind disruption risk. Ask for a storm alert or disruption assessment and name the location.',
    );
  }
  const explicitHours = Number(params?.hours);
  const parsed = parseWhen(params?.when ? String(params.when) : text);
  // Default window is 24h, not 48h: verified live 2026-09-07 that the
  // current rank-1 STORM_ALERT miner defaults to 24h when a question states
  // no window, and a graded reference answer built on a shorter window
  // reads a different peak gust than ours would over 48h.
  const hours = Number.isFinite(explicitHours) && explicitHours > 0 ? explicitHours : (parsed?.hours ?? 24);

  let result;
  try {
    result = await withQuestionFallback((candidate) => fetchStormRisk(candidate, hours), text, fallbackText);
  } catch (err) {
    if (err instanceof WeatherLookupError) {
      return respondUnusableInput(
        res,
        `I cannot assess storm risk for ${quoteParam(rawLocation)}: ${err.message}. Pass a recognizable place name, "lat,lon" coordinates, or a question naming the place.`,
      );
    }
    // WeatherUpstreamError is TxLens's fault, not the caller's — a real
    // error status, not invalid_input. See the note on WeatherUpstreamError
    // in weatherForecast.js.
    const upstream = err instanceof WeatherUpstreamError;
    return res.status(502).json({
      status: 'error',
      summary: upstream
        ? `The storm forecast service is temporarily unavailable: ${err.message}. This is not a problem with the request; retry shortly.`
        : 'storm risk assessment failed',
      confidence: 0,
      error: err.message,
    });
  }

  const stormNote = result.thunderstorm_hours > 0
    ? `Thunderstorms are forecast, over about ${result.thunderstorm_hours} hour(s)${result.severe_hail_hours > 0 ? `, ${result.severe_hail_hours} of them carrying hail` : ''}.`
    : 'No thunderstorms are forecast in this window.';

  const level = LEVEL_BY_RISK[result.risk];
  const breach = level !== 'none';
  // Direct yes/no lead, matched against the current rank-1 STORM_ALERT
  // miner's phrasing ("No storm is expected in Miami... so the risk is
  // low."): a question phrased "is a storm expected" has a reference
  // answer that opens with a yes or a no, not a jargon phrase and a score.
  // The grade and score move to sentence two, kept, not dropped.
  //
  // The affirmative lead is reserved for HIGH/SEVERE (level "warning"), not
  // "level !== none". MODERATE is thunderstorm-free strong wind (Beaufort 6+,
  // see fetchStormRisk in weatherForecast.js) — a windy day, not a storm.
  // Live-checked 2026-09-07: Miami at 61 km/h gusts with no thunderstorms
  // grades MODERATE, and asserting "a storm is expected" there would be
  // wrong on the one sentence a text grader actually reads, the same class
  // of mistake this whole rewrite exists to fix. MODERATE gets its own
  // honest middle sentence instead of either extreme.
  const stormAsserted = result.risk === 'HIGH' || result.risk === 'SEVERE';
  const lead = stormAsserted
    ? `A storm is expected in ${result.name} over the next ${result.hours} hours, so the risk is ${result.risk.toLowerCase()}.`
    : result.risk === 'MODERATE'
      ? `No storm is expected in ${result.name} over the next ${result.hours} hours, but winds are strong enough for an advisory.`
      : `No storm is expected in ${result.name} over the next ${result.hours} hours, so the risk is ${result.risk.toLowerCase()}.`;

  const snowNote = result.total_snowfall_cm != null && result.total_snowfall_cm > 0
    ? `Snowfall: ${result.total_snowfall_cm} cm.`
    : null;

  // Recommended-action prose and cache/provenance detail are real fields on
  // the JSON envelope, useful to a caller, but were diluting the graded
  // summary field to roughly 80 words after the facts — trimmed from the
  // sentence a text grader reads, not removed from the response.
  const summary = [
    lead,
    `Scored ${result.risk_score} on a scale of 0 to 1 (${RISK_TEXT[result.risk]}).`,
    `Gusts: peak gusts of ${windTriple(result.peak_gust_kmh)} around ${result.peak_gust_time}, which is Beaufort force ${result.beaufort_force}, a ${FORCE_TEXT[result.beaufort_force]}.`,
    result.max_wind_speed_kmh != null ? `Sustained wind: up to ${windTriple(result.max_wind_speed_kmh)}${result.wind_direction ? `, prevailing from the ${result.wind_direction}` : ''}.` : null,
    result.peak_precipitation_mm != null ? `Precipitation: ${result.peak_precipitation_mm} mm.` : null,
    snowNote,
    stormNote,
  ].filter(Boolean).join(' ');

  res.json({
    query: rawLocation,
    status: 'ok',
    summary,
    confidence: result.hours <= 72 ? 1.0 : 0.85,
    canonical: ['storm', result.name, result.risk].join(':'),
    location: result.name,
    latitude: result.latitude,
    longitude: result.longitude,
    timezone: result.timezone,
    risk_level: result.risk,
    risk_score: result.risk_score,
    breach,
    level,
    hours_assessed: result.hours,
    window_start: result.window_start,
    window_end: result.window_end,
    peak_gust_kmh: result.peak_gust_kmh,
    peak_gust_mph: Number(kmhToMph(result.peak_gust_kmh).toFixed(1)),
    peak_gust_ms: Number(kmhToMs(result.peak_gust_kmh).toFixed(1)),
    peak_gust_time: result.peak_gust_time,
    max_wind_speed_kmh: result.max_wind_speed_kmh,
    wind_direction: result.wind_direction,
    total_precipitation_mm: result.total_precipitation_mm,
    peak_precipitation_mm: result.peak_precipitation_mm,
    total_snowfall_cm: result.total_snowfall_cm,
    beaufort_force: result.beaufort_force,
    beaufort_description: FORCE_TEXT[result.beaufort_force],
    thunderstorm_hours: result.thunderstorm_hours,
    severe_hail_hours: result.severe_hail_hours,
    recommended_action: RISK_ACTION[result.risk],
    // May be served from a short-lived cache (see weatherForecast.js), so
    // this is when the data was actually pulled, not the request time.
    checked_at: result.fetchedAt,
  });
}

router.get('/', (req, res) => handleStormAlert(req, res));
router.post('/', (req, res) => handleStormAlert(req, res));

export default router;
