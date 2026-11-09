// DATACENTER_TELEMETRY_VERIFY: audits facility telemetry the caller supplies.
// There is no public datacenter feed, so nothing is invented: PUE is
// computed from total facility power and IT power, inlet temperature is
// checked against the ASHRAE recommended range (18 to 27 C), and generator
// readiness against fuel level and days since the last test. Values come
// from params or from numbers written in the question.

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { paramsOf } from '../lib/liveJson.js';

const router = Router();

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null;
};

export function readValues(params, text) {
  const t = String(text ?? '');
  const grab = (re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
  return {
    total: num(firstUsableValue(params.total_kw, params.facility_kw, params.total_power_kw)) ?? grab(/(?:total|facility)[^0-9]{0,25}([\d,.]+)\s*kw/i),
    it: num(firstUsableValue(params.it_kw, params.it_power_kw, params.it_load_kw)) ?? grab(/\bit\b[^0-9]{0,25}([\d,.]+)\s*kw/i),
    inlet: num(firstUsableValue(params.inlet_c, params.temperature_c, params.inlet_temp_c)) ?? grab(/(?:inlet|temp\w*)[^0-9-]{0,25}(-?[\d.]+)\s*(?:c\b|°c|celsius)/i),
    fuelPct: num(firstUsableValue(params.generator_fuel_pct, params.fuel_pct)) ?? grab(/fuel[^0-9]{0,25}([\d.]+)\s*%/i),
    testDays: num(firstUsableValue(params.generator_test_days, params.days_since_test)) ?? grab(/(\d+)\s*days?\s*since[^.]{0,20}test/i),
  };
}

export function pueRating(pue) {
  if (pue < 1.2) return 'excellent';
  if (pue < 1.5) return 'good';
  if (pue < 2) return 'average';
  return 'poor';
}

async function handle(req, res) {
  const params = paramsOf(req);
  const v = readValues(params, freeTextParam(params));
  const findings = [];
  const out = {};
  if (v.total != null && v.it != null) {
    if (v.it <= 0 || v.total < v.it) return respondUnusableInput(res, 'Total facility power must be at least the IT power, and IT power above zero, for PUE to be meaningful.');
    const pue = v.total / v.it;
    out.pue = Number(pue.toFixed(3));
    out.pue_rating = pueRating(pue);
    findings.push(`PUE ${pue.toFixed(2)} (${out.pue_rating}) from ${v.total} kW facility and ${v.it} kW IT load`);
  }
  if (v.inlet != null) {
    out.inlet_c = v.inlet;
    out.inlet_within_ashrae = v.inlet >= 18 && v.inlet <= 27;
    findings.push(`inlet ${v.inlet} C is ${out.inlet_within_ashrae ? 'within' : 'outside'} the ASHRAE recommended 18 to 27 C`);
  }
  if (v.fuelPct != null || v.testDays != null) {
    const fuelOk = v.fuelPct == null ? null : v.fuelPct >= 50;
    const testOk = v.testDays == null ? null : v.testDays <= 30;
    out.generator_ready = [fuelOk, testOk].every((x) => x !== false);
    findings.push(`generator ${out.generator_ready ? 'ready' : 'NOT ready'}${v.fuelPct != null ? `, fuel ${v.fuelPct}%` : ''}${v.testDays != null ? `, last test ${v.testDays} days ago` : ''}`);
  }
  if (!findings.length) {
    return respondUnusableInput(res, 'No datacenter readings found. Send total_kw and it_kw for PUE, inlet_c for thermal, and generator_fuel_pct or generator_test_days for generator readiness. I do not have a public datacenter feed, so I only audit values you give me.');
  }
  res.json({
    status: 'ok',
    summary: `Datacenter audit: ${findings.join('; ')}.`,
    confidence: 0.85,
    canonical: `datacenter-telemetry:${JSON.stringify(v)}`,
    ...out,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
