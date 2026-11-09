// SENSOR_TELEMETRY_VERIFY: validates one edge-sensor reading the caller
// supplies. Three deterministic checks: heartbeat freshness (reading
// timestamp within max_age_seconds, default 300), calibration bounds
// (value between min and max when given), and payload integrity (HMAC-SHA256
// of "sensor_id|value|timestamp" with the shared secret, compared in
// constant time to the supplied signature). Nothing is fetched.

import crypto from 'node:crypto';
import { Router } from 'express';
import { firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { paramsOf } from '../lib/liveJson.js';

const router = Router();

export function toEpochSeconds(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
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

async function handle(req, res) {
  let p = paramsOf(req);
  const payload = firstUsableValue(p.payload);
  if (typeof payload === 'string') { try { p = { ...p, ...JSON.parse(payload) }; } catch { /* fields stay as sent */ } }
  else if (payload && typeof payload === 'object') p = { ...p, ...payload };
  const sensorId = firstUsableValue(p.sensor_id, p.sensor, p.device_id, p.id);
  const value = firstUsableValue(p.value, p.reading);
  const rawTs = firstUsableValue(p.timestamp, p.ts, p.time);
  if (sensorId == null || value == null || rawTs == null) {
    return respondUnusableInput(res, 'Send sensor_id, value and timestamp (and optionally min, max, max_age_seconds, signature and secret) to verify a sensor reading.');
  }
  const ts = toEpochSeconds(rawTs);
  if (ts == null) return respondUnusableInput(res, 'timestamp must be a unix time or an ISO date.');
  const maxAge = Number(firstUsableValue(p.max_age_seconds, p.heartbeat_seconds) ?? 300);
  const now = Math.floor(Date.now() / 1000);
  const age = now - ts;
  const checks = {};
  checks.heartbeat_fresh = age <= maxAge && age >= -60;
  const v = Number(value);
  const min = firstUsableValue(p.min, p.min_value);
  const max = firstUsableValue(p.max, p.max_value);
  if (Number.isFinite(v) && (min != null || max != null)) {
    checks.within_calibration_bounds = (min == null || v >= Number(min)) && (max == null || v <= Number(max));
  }
  const signature = firstUsableValue(p.signature, p.hmac);
  const secret = firstUsableValue(p.secret, p.key);
  if (signature != null && secret != null) checks.signature_valid = safeEqualHex(signature, sign(secret, sensorId, value, rawTs));
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  const valid = failed.length === 0;
  res.json({
    status: 'ok',
    summary: `Sensor ${sensorId} reading ${value} is ${valid ? 'VALID' : `INVALID (failed: ${failed.join(', ')})`}; reading age ${age}s against a ${maxAge}s heartbeat window${'signature_valid' in checks ? `, signature ${checks.signature_valid ? 'matches' : 'does not match'}` : ', no signature supplied so integrity was not checked'}.`,
    confidence: 0.9,
    canonical: `sensor-telemetry:${sensorId}:${rawTs}:${value}`,
    valid,
    checks,
    age_seconds: age,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
