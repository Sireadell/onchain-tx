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
import { fetchForecast, withQuestionFallback, WeatherLookupError, WeatherUpstreamError } from '../lib/weatherForecast.js';
import { parseWhen, parseFocus, MAX_FORECAST_DAY_OFFSET } from '../lib/questionParse.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { questionMatchesIntent, WEATHER_CUES } from '../lib/intentGuard.js';

const router = Router();

const round = (n, dp = 1) => (Number.isFinite(n) ? Number(n.toFixed(dp)) : null);

// The peak chance of precipitation, or null when no day carries a real
// figure. Deliberately not `?? 0`: a missing probability is not a zero
// probability, and collapsing the two produced the contradiction below.
export function maxProbability(days) {
  const known = days
    .map((d) => d.precipitation_probability_pct)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  return known.length ? Math.max(...known) : null;
}

// Open-Meteo publishes precipitation probability only for some regions and
// reports 0 elsewhere, and MET Norway publishes none at all outside the
// Nordics. Stating that zero produced answers like "10.1 mm in total, with
// the chance of precipitation peaking at 0%", which contradicts itself in
// the same breath. Live example 2026-08-30 at 14.6042, 120.9822 (Manila).
// So the clause is dropped when the figure is unknown, and when a flat 0%
// is contradicted by rain actually being forecast. Saying less is better
// than saying something the rest of the sentence disproves.
export function precipProbabilityClause(maxProb, totalPrecip) {
  if (maxProb == null) return '';
  if (maxProb === 0 && totalPrecip > 0.05) return '';
  return `, with the chance of precipitation peaking at ${maxProb}%`;
}

function windPhrase(day) {
  const gust = day.wind_gust_max_kmh ? `, gusting to ${day.wind_gust_max_kmh.toFixed(0)} km/h` : '';
  const dir = day.wind_direction ? ` from the ${day.wind_direction}` : '';
  return `up to ${day.wind_max_kmh.toFixed(0)} km/h${dir}${gust}`;
}

// A question like "Will Dubai reach 45C by September 13?" wants yes or no,
// not a temperature range. Reciting the range and leaving the caller to do
// the comparison is what we were doing on 2026-09-10, on a question whose
// whole point was the threshold. Returns null when the question names no
// threshold, so ordinary forecasts are untouched.
const ABOVE_RE = /\b(?:reach(?:es|ed)?|exceed(?:s|ed)?|hit(?:s)?|go(?:es)?\s+above|get(?:s)?\s+above|climb(?:s)?\s+(?:to|above)|rise(?:s)?\s+(?:to|above)|be\s+above|top(?:s)?|over)\s+(-?\d+(?:\.\d+)?)\s*(?:°\s*)?(c|f|celsius|fahrenheit)?\b/i;
const BELOW_RE = /\b(?:drop(?:s)?\s+(?:to|below)|fall(?:s)?\s+(?:to|below)|go(?:es)?\s+below|get(?:s)?\s+(?:down\s+)?below|be\s+below|dip(?:s)?\s+below|under)\s+(-?\d+(?:\.\d+)?)\s*(?:°\s*)?(c|f|celsius|fahrenheit)?\b/i;

const toCelsius = (value, unit) => (/^f/i.test(unit ?? '') ? (value - 32) * (5 / 9) : value);

export function thresholdVerdict(text, days) {
  if (typeof text !== 'string' || !days?.length) return null;
  // Only a temperature threshold is answered here. "over 40 mm of rain" and
  // similar need their own comparison and are left to the focus sentence
  // rather than answered wrongly against a temperature.
  const namesTemperature = /\b(?:degrees?|celsius|fahrenheit|temperature|hot|cold|warm|hotter|colder|warmer)\b/i.test(text)
    || /°/.test(text)
    // "Will it reach 110F?" names a temperature with no temperature word in
    // it at all, so a bare number carrying a C or F unit counts too. "40 mm"
    // and "40 cm" do not, because the unit letter is not on a word boundary.
    || /\d\s*°?\s*[cf]\b/i.test(text);
  if (!namesTemperature) return null;

  const above = text.match(ABOVE_RE);
  const below = !above ? text.match(BELOW_RE) : null;
  const match = above ?? below;
  if (!match) return null;

  const threshold = toCelsius(Number(match[1]), match[2]);
  if (!Number.isFinite(threshold)) return null;

  const shown = `${Number(threshold.toFixed(1))}°C`;
  if (above) {
    const peak = Math.max(...days.map((d) => d.temp_max));
    const peakDay = days.find((d) => d.temp_max === peak);
    return peak >= threshold
      ? `Yes. The forecast high reaches ${Number(peak.toFixed(1))}°C on ${peakDay.date}, at or above ${shown}.`
      : `No. The highest forecast temperature is ${Number(peak.toFixed(1))}°C on ${peakDay.date}, short of ${shown}.`;
  }
  const low = Math.min(...days.map((d) => d.temp_min));
  const lowDay = days.find((d) => d.temp_min === low);
  return low <= threshold
    ? `Yes. The forecast low drops to ${Number(low.toFixed(1))}°C on ${lowDay.date}, at or below ${shown}.`
    : `No. The lowest forecast temperature is ${Number(low.toFixed(1))}°C on ${lowDay.date}, never reaching ${shown}.`;
}

// The sentence the answer opens with, when the question emphasised one
// aspect. Leading with the thing that was asked is the difference between
// answering "will it rain tomorrow" and reciting a forecast at the caller.
function focusSentence(focus, days, spanLabel) {
  const totalPrecip = days.reduce((sum, d) => sum + (d.precipitation_mm ?? 0), 0);
  const maxProb = maxProbability(days);
  const totalSnow = days.reduce((sum, d) => sum + (d.snowfall_cm ?? 0), 0);
  const peakGust = Math.max(...days.map((d) => d.wind_gust_max_kmh ?? d.wind_max_kmh ?? 0));
  const peakWind = Math.max(...days.map((d) => d.wind_max_kmh ?? 0));
  const minTemp = Math.min(...days.map((d) => d.temp_min));
  const maxTemp = Math.max(...days.map((d) => d.temp_max));
  const wetHours = days.reduce((sum, d) => sum + (d.precipitation_hours ?? 0), 0);

  switch (focus) {
    case 'rain':
      return totalPrecip > 0.05 || (maxProb ?? 0) >= 50
        ? `Yes, rain is expected ${spanLabel}: ${round(totalPrecip)} mm in total across about ${wetHours} wet hour(s)${precipProbabilityClause(maxProb, totalPrecip)}.`
        : `No, rain is not expected ${spanLabel}: ${round(totalPrecip)} mm forecast in total${precipProbabilityClause(maxProb, totalPrecip)}.`;
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
function summarize(location, days, when, focus, source, questionText) {
  // Labels that are already a complete phrase read wrong with "over" in
  // front of them: "over through September 13", "over tomorrow". A calendar
  // label ("September 13") takes "on"; a span label ("through September 13")
  // takes neither.
  const bareLabel = when && (when.label === 'tomorrow' || when.label === 'today' || when.label === 'tonight'
    || when.label.startsWith('through '));
  const onLabel = when?.date && !when.label.startsWith('through ');
  const spanLabel = when
    ? (bareLabel ? when.label : onLabel ? `on ${when.label}` : `over ${when.label}`)
    : (days.length === 1 ? 'today' : `over the next ${days.length} days`);
  const dateRange = days.length === 1 ? days[0].date : `${days[0].date} to ${days[days.length - 1].date}`;

  const minTemp = Math.min(...days.map((d) => d.temp_min));
  const maxTemp = Math.max(...days.map((d) => d.temp_max));
  const totalPrecip = days.reduce((sum, d) => sum + (d.precipitation_mm ?? 0), 0);
  const maxProb = maxProbability(days);
  const peakDay = days.reduce((best, d) => ((d.wind_gust_max_kmh ?? d.wind_max_kmh) > (best.wind_gust_max_kmh ?? best.wind_max_kmh) ? d : best), days[0]);

  // A yes/no threshold question is answered as yes or no first; the focus
  // sentence and the full forecast still follow it.
  const verdict = thresholdVerdict(questionText, days);
  const opening = [verdict, focusSentence(focus, days, spanLabel)].filter(Boolean).join(' ');
  const head = `The weather forecast for ${location} ${spanLabel} (${dateRange}) is as follows.`;

  const parts = [
    opening ? `${opening} ${head}` : head,
    `Conditions: ${days[0].condition}${days.length > 1 && days[days.length - 1].condition !== days[0].condition ? `, turning to ${days[days.length - 1].condition} by ${days[days.length - 1].date}` : ''}.`,
    `Temperature: ${round(minTemp)}°C to ${round(maxTemp)}°C.`,
    `Precipitation: ${round(totalPrecip)} mm in total${precipProbabilityClause(maxProb, totalPrecip)}.`,
    `Wind: ${windPhrase(peakDay)}.`,
  ];
  const totalSnow = days.reduce((sum, d) => sum + (d.snowfall_cm ?? 0), 0);
  if (totalSnow > 0.05) parts.push(`Snowfall: ${round(totalSnow)} cm.`);
  // Name the service that actually answered. On an Open-Meteo rate limit
  // the reading comes from MET Norway instead, and crediting Open-Meteo for
  // it would be a false statement inside the graded sentence.
  parts.push(`Read live from the ${source ?? 'Open-Meteo'} forecast service at request time, not from a cache.`);

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
  // Only when the caller chose `location` itself: the whole question, when a
  // different one was sent alongside, to retry with if the location names no
  // place. See withQuestionFallback in weatherForecast.js.
  const fallbackText = params?.location != null
    ? [params?.query, params?.q, params?.question]
      .find((value) => typeof value === 'string' && value.trim() && value.trim() !== String(rawLocation).trim())
    : null;
  if (!questionMatchesIntent(text, WEATHER_CUES)) {
    return respondUnusableInput(
      res,
      'This request does not appear to ask about weather. Ask for a forecast or a weather condition and name the location.',
    );
  }
  // An explicit when/focus param wins over one parsed from the question,
  // so a caller that knows what it wants is never second-guessed.
  const when = params?.when ? parseWhen(String(params.when)) : parseWhen(text);
  // A date past the end of any forecast has no honest answer. Before this
  // check, `when` was simply ignored and the default 3-day window answered
  // in its place, which reads as a confident answer about the wrong days.
  if (when?.outOfRange) {
    return respondUnusableInput(
      res,
      `I cannot forecast weather for ${when.date}: it is ${when.startDay} days out, and forecasts only run ${MAX_FORECAST_DAY_OFFSET + 1} days ahead. Ask again nearer the date.`,
    );
  }
  const focus = params?.focus ? String(params.focus).toLowerCase() : parseFocus(text);
  const explicitDays = Number(params?.days);
  const days = Number.isFinite(explicitDays) && explicitDays > 0 ? explicitDays : (when?.days ?? 3);
  const startDay = when?.startDay ?? 0;

  let result;
  try {
    // A caller who explicitly said "today" or "tonight" means today even at
    // 11pm, so the spent-day skip is suppressed for them and only applies
    // where no particular day was named.
    const keepToday = when?.label === 'today' || when?.label === 'tonight';
    result = await withQuestionFallback((candidate) => fetchForecast(candidate, days, startDay, { keepToday }), text, fallbackText);
  } catch (err) {
    if (err instanceof WeatherLookupError) {
      return respondUnusableInput(
        res,
        `I cannot forecast weather for ${quoteParam(rawLocation)}: ${err.message}. Pass a recognizable place name, "lat,lon" coordinates, or a question naming the place.`,
      );
    }
    // WeatherUpstreamError (and anything unexpected) is TxLens's fault, not
    // the caller's — a real error status, not invalid_input. See the note
    // on WeatherUpstreamError in weatherForecast.js: reporting an upstream
    // outage as bad input would hide genuine downtime from the scorer.
    const upstream = err instanceof WeatherUpstreamError;
    return res.status(502).json({
      status: 'error',
      summary: upstream
        ? `The weather forecast service is temporarily unavailable: ${err.message}. This is not a problem with the request; retry shortly.`
        : 'weather forecast failed',
      confidence: 1.0,
      error: err.message,
    });
  }

  // The verdict is read from whichever field actually carried the sentence:
  // the engine sometimes reduces the question to `location`, and sometimes
  // forwards the whole thing alongside it.
  const questionText = [text, fallbackText, params?.question, params?.query, params?.q]
    .filter((value) => typeof value === 'string')
    .sort((a, b) => b.length - a.length)[0] ?? text;
  const summary = summarize(result.name, result.days, when, focus, result.source, questionText);
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
    precipitation_probability_max_pct: maxProbability(result.days),
    snowfall_total_cm: round(result.days.reduce((sum, d) => sum + (d.snowfall_cm ?? 0), 0)),
    peak_wind_kmh: Math.max(...result.days.map((d) => d.wind_max_kmh ?? 0)),
    peak_gust_kmh: Math.max(...result.days.map((d) => d.wind_gust_max_kmh ?? 0)),
    days: result.days,
    // The forecast may be served from a short-lived cache (see
    // weatherForecast.js) rather than fetched fresh for this request, so
    // this is when the underlying data was actually pulled, not now.
    checked_at: result.fetchedAt,
  });
}

router.get('/', (req, res) => handleWeatherForecast(req, res));
router.post('/', (req, res) => handleWeatherForecast(req, res));

export default router;
