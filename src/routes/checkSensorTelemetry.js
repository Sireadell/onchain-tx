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
const UNIT = String.raw`(?:\u00b0\s?[CF]|\s?degrees?(?:\s+(?:celsius|fahrenheit|[CF]))?|\s?celsius|\s?fahrenheit|\s?[CF](?![A-Za-z])|\s?%|\s?ppm|\s?ppb|\s?psi|\s?kpa|\s?hpa|\s?mbar|\s?bar|\s?volts?|\s?mv|\s?v(?![A-Za-z])|\s?ma(?![A-Za-z])|\s?amps?|\s?kw|\s?w(?![A-Za-z])|\s?lux|\s?db|\s?rpm|\s?m\/s|\s?km\/h|\s?mph|\s?hz|\s?\u00b5g\/m3|\s?ug\/m3|\s?mm(?![A-Za-z])|\s?cm(?![A-Za-z]))`;

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
export function readQuestion(text) {
  const out = { reading: null, unit: null, min: null, max: null };
  if (typeof text !== 'string' || !text.trim()) return out;
  let rest = text;

  const rangeRe = new RegExp(String.raw`\b(?:between|from|range(?:\s+of)?|expected|normal|within|allowed|acceptable|safe|operating|should be)\s*:?\s*(${NUM})\s*(${UNIT})?\s*(?:to|and|through|\u2013|\u2014|-)\s*(${NUM})\s*(${UNIT})?`, 'i');
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
    sentence = `${name}: no numeric reading could be found in the request${value != null ? ` (value "${String(value).slice(0, 40)}" is not a number)` : ''}, so I cannot judge it. Send the reading with its unit and the expected range, for example "reads 31.5 C, expected -5 to 30".`;
  }
  if (performed.heartbeat_fresh === false) sentence += ` The reading timestamp is ${age}s old against a ${maxAge}s heartbeat window, so it is stale.`;
  else if (performed.heartbeat_fresh === true) sentence += ` The reading is fresh (${age}s old).`;
  if (performed.signature_valid === true) sentence += ' The signature matches.';

  const valid = Object.values(performed).length > 0 && Object.values(performed).every(Boolean);

  res.json({
    summary: `${verdict}. ${sentence}`,
    status: 'ok',
    verdict,
    confidence: verdict === 'Insufficient information' ? 0.5 : 0.9,
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
