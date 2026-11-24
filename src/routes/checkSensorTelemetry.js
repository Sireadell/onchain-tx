// SENSOR_TELEMETRY_VERIFY: judges one edge-sensor reading the caller
// supplies. Checks that can run: heartbeat freshness (reading timestamp within
// max_age_seconds, default 300), calibration bounds (value between min and
// max), and payload integrity (HMAC-SHA256 of "sensor_id|value|timestamp"
// with the shared secret, compared in constant time to the supplied
// signature). Nothing is fetched.
//
// The request builder often sends junk for the structured fields (value
// "N/A", a text label, a nanosecond timestamp) and puts the real question in
// free text. So this route never refuses: it reads numbers and a range out of
// the sentence, answers with a verdict word first, and lists in `checks`
// what it did and did not check.

import crypto from 'node:crypto';
import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { paramsOf } from '../lib/liveJson.js';
import { findPublicSensor, readPublicSensor, freshnessWindowSeconds } from '../lib/publicSensors.js';

const router = Router();

export function toEpochSeconds(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n > 1e15) return Math.floor(n / 1e9); // nanoseconds
    if (n > 1e12) return Math.floor(n / 1e3); // milliseconds
    return Math.floor(n);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function sign(secret, sensorId, value, ts) {
  return crypto.createHmac('sha256', String(secret)).update(`${sensorId}|${value}|${ts}`).digest('hex');
}

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a).toLowerCase(), 'utf8');
  const y = Buffer.from(String(b).toLowerCase(), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const NUM = String.raw`[-+\u2212]?\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:\s?(?:meters?|metres?|feet|ft)(?![A-Za-z])|\s?m(?![A-Za-z\/])|\u00b0\s?[CF]|\s?degrees?(?:\s+(?:celsius|fahrenheit|[CF]))?|\s?celsius|\s?fahrenheit|\s?[CF](?![A-Za-z])|\s?%|\s?ppm|\s?ppb|\s?psi|\s?kpa|\s?hpa|\s?mbar|\s?bar|\s?volts?|\s?mv|\s?v(?![A-Za-z])|\s?ma(?![A-Za-z])|\s?amps?|\s?kw|\s?w(?![A-Za-z])|\s?lux|\s?db|\s?rpm|\s?m\/s|\s?km\/h|\s?mph|\s?hz|\s?\u00b5g\/m3|\s?ug\/m3|\s?mm(?![A-Za-z])|\s?cm(?![A-Za-z]))`;

function toNum(s) {
  return Number(String(s).replace('\u2212', '-').replace(',', '.'));
}

function cleanUnit(u) {
  if (!u) return null;
  const t = u.trim();
  if (/^\u00b0?\s?c$|^degrees?\s*c|celsius/i.test(t)) return 'C';
  if (/^\u00b0?\s?f$|^degrees?\s*f|fahrenheit/i.test(t)) return 'F';
  if (/^degrees?$/i.test(t)) return 'degrees';
  return t;
}

// Pulls the reading, unit and any limits out of a sentence such as
// "Sensor zone-3 reads 31.5 C, expected -5 to 30" or "pressure 12 psi, max 10".
// Removes numbers that are ids, addresses, dates or time windows, so
// "192.168.1.100", "UUID 70101020" or "within the last 24 hours" are never
// read as the sensor value.
export function stripNonReadings(text) {
  return String(text)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/gi, ' ')
    .replace(/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\b(?:uuid|id|site|station|sensor|device|node|feed|gauge|gage|no\.?|number|#)\s*[:#]?\s*[`'"(]?[A-Za-z_-]*\d[\w-]*/gi, ' ')
    .replace(/\b(?:last|past|within|older than|less than|under|every)\s+(?:the\s+)?(?:last\s+)?\d+\s*(?:seconds?|secs?|s|minutes?|mins?|hours?|hrs?|h|days?)\b/gi, ' ')
    .replace(/\b\d+\s*(?:seconds?|minutes?|hours?|days?)\s+old\b/gi, ' ')
    .replace(/\b[A-Za-z]+[-_]\d[\w-]*/g, ' ');
}

export function readQuestion(text) {
  const out = { reading: null, unit: null, min: null, max: null };
  if (typeof text !== 'string' || !text.trim()) return out;
  let rest = stripNonReadings(text);

  const rangeRe = new RegExp(String.raw`\b(?:between|from|range(?:\s+of)?|plausible range|calibration range|expected|normal|within|allowed|acceptable|safe|operating|should be)\s*:?\s*(?:(?:the|its|an?|expected|range of|of)\s+)*(${NUM})\s*(${UNIT})?\s*(?:to|and|through|\u2013|\u2014|-)\s*(${NUM})\s*(${UNIT})?`, 'i');
  const range = rest.match(rangeRe);
  if (range) {
    const a = toNum(range[1]);
    const b = toNum(range[3]);
    out.min = Math.min(a, b);
    out.max = Math.max(a, b);
    out.unit = cleanUnit(range[4] || range[2]);
    rest = rest.replace(range[0], ' ');
  }

  const maxRe = new RegExp(String.raw`(?:\b(?:above|over|exceeds?|exceeding|greater than|more than|higher than|max(?:imum)?(?:\s+of)?|upper (?:limit|threshold|bound)|at most|up to|not (?:to )?exceed|limit of|threshold of)|>=?)\s*:?\s*(${NUM})\s*(${UNIT})?`, 'i');
  const minRe = new RegExp(String.raw`(?:\b(?:below|under|less than|lower than|min(?:imum)?(?:\s+of)?|lower (?:limit|threshold|bound)|at least)|<=?)\s*:?\s*(${NUM})\s*(${UNIT})?`, 'i');
  const hi = out.max == null ? rest.match(maxRe) : null;
  if (hi) { out.max = toNum(hi[1]); out.unit = out.unit ?? cleanUnit(hi[2]); rest = rest.replace(hi[0], ' '); }
  const lo = out.min == null ? rest.match(minRe) : null;
  if (lo) { out.min = toNum(lo[1]); out.unit = out.unit ?? cleanUnit(lo[2]); rest = rest.replace(lo[0], ' '); }

  // What is left holds the reading: prefer a number with a unit.
  const withUnit = rest.match(new RegExp(String.raw`(?<![\w.])(${NUM})\s*(${UNIT})`, 'i'));
  if (withUnit) {
    out.reading = toNum(withUnit[1]);
    out.unit = out.unit ?? cleanUnit(withUnit[2]);
  } else {
    const bare = rest.replace(/[A-Za-z_][\w\-/]*\d[\w\-/]*/g, ' ').match(new RegExp(String.raw`(?<![\w.])(${NUM})(?![\w])`));
    if (bare) out.reading = toNum(bare[1]);
  }
  return out;
}

function implausible(reading, unit) {
  if (reading == null) return false;
  if (unit === 'C' && reading < -273.15) return true;
  if (unit === 'F' && reading < -459.67) return true;
  if (unit === '%' && (reading < 0 || reading > 100)) return true;
  return false;
}

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));
const withUnitText = (n, unit) => `${fmt(n)}${unit ? (unit === '%' ? '%' : ` ${unit}`) : ''}`;

function sensorLabel(question, sensorId) {
  if (sensorId != null) return String(sensorId);
  const q = String(question ?? '');
  const m = q.match(/Requested sensor:\s*\\?"?([^"\\.]+)/i)
    || q.match(/sensor\s+(?:ID\s*:?\s*)?['"`]([^'"`]+)['"`]/i)
    || q.match(/['"`]([^'"`]{2,60})['"`]\s+sensor/i)
    || q.match(/\(ID:\s*([^)]+)\)/i)
    || q.match(/sensor\s+(?:ID\s+)?([A-Z][\w-]*\d[\w-]*)/);
  return m ? m[1].trim() : 'the sensor';
}

// No live public reading and none supplied: say so plainly as a verdict, not
// as a request for more input.
function notVerified(sensorId, question, live, found, limits = {}) {
  const label = sensorLabel(question, sensorId);
  const q = String(question ?? '');
  const privateFeed = /mqtt|192\.168\.|\b10\.\d+\.\d+\.\d+|localhost|raspberry|home\/|building\/|topic/i.test(q);
  let where;
  if (found?.kind === 'usgs') where = `USGS site ${found.id} returned no current value${live?.error ? ` (${live.error})` : ''}`;
  else if (found?.kind === 'pegel') where = `no PEGELONLINE gauge matches ${[...(found.ids ?? []), ...(found.names ?? [])].join(', ') || 'the request'}`;
  else if (found?.kind === 'nws') where = `NWS station ${found.id} returned no current observation${live?.error ? ` (${live.error})` : ''}`;
  else if (privateFeed) where = 'it is a private feed (an MQTT topic or local device) that is not published on any public network';
  else where = 'it is not on any public sensor network this service reads (USGS, PEGELONLINE, NWS, Sensor.Community)';
  const range = limits.min != null || limits.max != null
    ? ` The expected range (${limits.min ?? '-'} to ${limits.max ?? '-'}${limits.unit ? ` ${limits.unit}` : ''}) cannot be checked without a reading.`
    : '';
  return {
    summary: `Not verified. No live reading for ${label} could be obtained: ${where}. So it cannot be confirmed that the sensor is reporting, the freshness of its data cannot be established (no observed_at), and no payload signature (HMAC) was supplied to verify.${range} Treat the sensor as unconfirmed until a timestamped, signed reading is available.`,
    status: 'ok',
    verdict: 'Not verified',
    found: false,
    confidence: 0.6,
    canonical: `sensor-telemetry:${label}:not-verified`,
    valid: false,
    sensor_id: label,
    reading: null,
    observed_at: null,
    reporting: null,
    within_range: null,
    signature_valid: null,
    checks: { performed: {}, not_performed: ['live reading', 'heartbeat freshness', 'calibration bounds', 'payload signature'] },
    source: live?.source ?? null,
    checked_at: new Date().toISOString(),
  };
}

const fmtN = (n) => (Number.isInteger(n) ? String(n) : String(Number(Number(n).toFixed(3))));

function liveAnswer(live, question, min, max) {
  const q = String(question ?? '');
  let value = live.value;
  let unit = live.unit;
  if (unit === 'cm' && /\d\s*(?:m|meters?|metres?)\b/i.test(q)) { value = Number((value / 100).toFixed(3)); unit = 'm'; }
  const obs = live.observed_at ? Date.parse(live.observed_at) : null;
  const ageS = obs ? Math.round((Date.now() - obs) / 1000) : null;
  const defaultWindow = /^(USGS|US National)/.test(live.source ?? '') ? 7200 : 3600;
  const windowS = freshnessWindowSeconds(q) ?? defaultWindow;
  const fresh = ageS != null && ageS <= windowS && ageS > -300;
  const hasRange = min != null || max != null;
  const inRange = hasRange ? (min == null || value >= min) && (max == null || value <= max) : null;
  const ageText = ageS == null ? 'no observation time' : ageS < 120 ? `${ageS} s ago` : ageS < 7200 ? `${Math.round(ageS / 60)} min ago` : `${(ageS / 3600).toFixed(1)} h ago`;
  const winText = windowS % 3600 === 0 ? `${windowS / 3600} h` : windowS % 60 === 0 ? `${windowS / 60} min` : `${windowS} s`;
  let verdict = 'Live';
  if (!fresh) verdict = 'Stale';
  else if (inRange === false) verdict = 'Out of range';
  else if (inRange === true) verdict = 'Within range';
  const u = unit ? ` ${unit}` : '';
  let rangeText = '';
  if (hasRange && inRange) rangeText = ` That is inside the expected ${min ?? '-'} to ${max ?? '-'}${u}.`;
  else if (hasRange) rangeText = ` That is ${max != null && value > max ? `above the upper limit ${max}${u} by ${fmtN(value - max)}` : `below the lower limit ${min}${u} by ${fmtN(min - value)}`} (expected ${min ?? '-'} to ${max ?? '-'}${u}).`;
  else if (/calibrat/i.test(q)) rangeText = ' No numeric calibration range was given, so liveness and the value are reported.';
  const metricNote = live.metric_matched === false ? ' (the metric asked for is not currently reported at this site, so its most recent live series is shown)' : '';
  const state = live.state && live.state !== 'unknown' ? ` Gauge state: ${live.state}.` : '';
  const others = (live.other_series ?? []).filter((o) => o.value != null).slice(0, 2).map((o) => `${o.metric} ${o.value}${o.unit ? ` ${o.unit}` : ''}`).join('; ');
  const summary = `${verdict}. ${live.id}${live.site_name ? ` (${live.site_name})` : ''} is ${fresh ? 'reporting live' : 'not reporting fresh data'}: ${live.metric ?? 'reading'} ${fmtN(value)}${u} observed at ${live.observed_at ?? 'an unknown time'} (${ageText}, ${fresh ? 'inside' : 'outside'} the ${winText} freshness window)${metricNote}.${rangeText}${state}${others ? ` Other live values: ${others}.` : ''} Integrity: the value is read directly from the operator's HTTPS service; the public feed carries no HMAC, so a payload signature cannot be checked. Source: ${live.source}.`;
  return {
    summary,
    status: 'ok',
    verdict,
    found: true,
    confidence: 0.9,
    canonical: `sensor-telemetry:${live.id}:${live.observed_at}`,
    valid: fresh && inRange !== false,
    sensor_id: live.id,
    site_name: live.site_name ?? null,
    metric: live.metric,
    reading: value,
    unit,
    observed_at: live.observed_at,
    age_seconds: ageS,
    freshness_window_seconds: windowS,
    reporting: fresh,
    within_range: inRange,
    min,
    max,
    signature_valid: null,
    checks: { performed: { heartbeat_fresh: fresh, ...(hasRange ? { within_calibration_bounds: inRange } : {}) }, not_performed: ['signature_valid (public feed is not signed)'] },
    source: live.source,
    checked_at: new Date().toISOString(),
  };
}

async function handle(req, res) {
  let p = paramsOf(req);
  const payload = firstUsableValue(p.payload);
  if (typeof payload === 'string') { try { p = { ...p, ...JSON.parse(payload) }; } catch { /* fields stay as sent */ } }
  else if (payload && typeof payload === 'object') p = { ...p, ...payload };

  const sensorId = firstUsableValue(p.sensor_id, p.sensor, p.device_id, p.id);
  const value = firstUsableValue(p.value, p.reading);
  const rawTs = firstUsableValue(p.timestamp, p.ts, p.time);
  const question = freeTextParam(p);
  const valueText = value != null && !Number.isFinite(Number(value)) ? String(value) : null;
  const fromText = readQuestion([question, valueText].filter(Boolean).join('. '));

  // Structured fields win when they are usable; the sentence fills the gaps.
  const structuredReading = value != null && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const reading = structuredReading ?? fromText.reading;
  const unit = fromText.unit;
  const minRaw = firstUsableValue(p.min, p.min_value);
  const maxRaw = firstUsableValue(p.max, p.max_value);
  const min = minRaw != null && Number.isFinite(Number(minRaw)) ? Number(minRaw) : fromText.min;
  const max = maxRaw != null && Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : fromText.max;

  if (structuredReading == null && question) {
    const found = findPublicSensor(question);
    if (found) {
      let live = null;
      try { live = await readPublicSensor(found, question); } catch (err) { live = { found: false, error: String(err.message ?? err), source: found.kind }; }
      if (live?.found && live.value != null) return res.json(liveAnswer(live, question, min, max));
      if (found.kind !== 'pegel' || found.strong) return res.json(notVerified(sensorId, question, live, found, { min, max, unit }));
    }
  }

  const ts = toEpochSeconds(rawTs);
  const maxAge = Number(firstUsableValue(p.max_age_seconds, p.heartbeat_seconds) ?? 300);
  const now = Math.floor(Date.now() / 1000);
  const age = ts == null ? null : now - ts;

  const performed = {};
  const notPerformed = [];
  if (age != null) performed.heartbeat_fresh = age <= maxAge && age >= -60;
  else notPerformed.push(rawTs == null ? 'heartbeat_fresh (no timestamp supplied)' : `heartbeat_fresh (timestamp "${String(rawTs).slice(0, 40)}" is not a unix time or date)`);

  if (reading != null && (min != null || max != null)) {
    performed.within_calibration_bounds = (min == null || reading >= min) && (max == null || reading <= max);
  } else if (reading == null) {
    notPerformed.push(`within_calibration_bounds (no numeric reading found${value != null ? `, value "${String(value).slice(0, 40)}" is not a number` : ''})`);
  } else {
    notPerformed.push('within_calibration_bounds (no min, max or expected range supplied)');
  }

  const signature = firstUsableValue(p.signature, p.hmac);
  const secret = firstUsableValue(p.secret, p.key);
  if (signature != null && secret != null && sensorId != null && value != null && rawTs != null) {
    performed.signature_valid = safeEqualHex(signature, sign(secret, sensorId, value, rawTs));
  } else {
    notPerformed.push('signature_valid (no usable signature and secret supplied, so payload integrity is not verified)');
  }

  let verdict;
  if (performed.signature_valid === false || implausible(reading, unit)) verdict = 'Anomalous';
  else if (performed.within_calibration_bounds === false) verdict = 'Out of range';
  else if (performed.within_calibration_bounds === true) verdict = 'Within range';
  else verdict = 'Insufficient information';

  const name = sensorId != null ? `Sensor ${sensorId}` : 'The sensor';
  const readingText = reading != null ? withUnitText(reading, unit) : null;
  const limitText = min != null && max != null ? `${fmt(min)} to ${withUnitText(max, unit)}` : max != null ? `a maximum of ${withUnitText(max, unit)}` : min != null ? `a minimum of ${withUnitText(min, unit)}` : null;
  let sentence;
  if (verdict === 'Anomalous') {
    sentence = performed.signature_valid === false
      ? `${name} reading${readingText ? ` ${readingText}` : ''} fails the payload signature check, so the data cannot be trusted.`
      : `${name} reading ${readingText} is physically implausible for that unit and should be treated as a sensor fault.`;
  } else if (verdict === 'Out of range') {
    const side = max != null && reading > max ? `above the upper limit ${withUnitText(max, unit)} by ${fmt(reading - max)}` : `below the lower limit ${withUnitText(min, unit)} by ${fmt(min - reading)}`;
    sentence = `${name} reading ${readingText} is ${side} (allowed ${limitText}).`;
  } else if (verdict === 'Within range') {
    sentence = `${name} reading ${readingText} is inside the allowed ${limitText}.`;
  } else if (reading != null) {
    sentence = `${name} reads ${readingText}, but no minimum, maximum or expected range was given, so I cannot say whether that is normal.`;
  } else {
    verdict = 'Not verified';
    sentence = notVerified(sensorId, question, null, null, { min, max, unit }).summary.replace(/^Not verified\. /, '');
  }
  if (performed.heartbeat_fresh === false) sentence += ` The reading timestamp is ${age}s old against a ${maxAge}s heartbeat window, so it is stale.`;
  else if (performed.heartbeat_fresh === true) sentence += ` The reading is fresh (${age}s old).`;
  if (performed.signature_valid === true) sentence += ' The signature matches.';

  const valid = Object.values(performed).length > 0 && Object.values(performed).every(Boolean);

  res.json({
    summary: `${verdict}. ${sentence}`,
    status: 'ok',
    verdict,
    confidence: verdict === 'Insufficient information' || verdict === 'Not verified' ? 0.6 : 0.9,
    canonical: `sensor-telemetry:${sensorId ?? 'unknown'}:${rawTs ?? ''}:${value ?? reading ?? ''}`,
    valid,
    checks: { performed, not_performed: notPerformed },
    sensor_id: sensorId ?? null,
    reading,
    unit,
    min,
    max,
    age_seconds: age,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
