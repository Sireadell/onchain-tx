// GRID_POWER_PRICE: day-ahead wholesale electricity price for a European
// bidding zone from Energy-Charts (Fraunhofer ISE, data from ENTSO-E and
// Bundesnetzagentur, no key). US operators (ERCOT, PJM, CAISO) need keys
// we do not hold, so a US question is told which zones are covered rather
// than answered with a wrong region.

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { getJson, upstreamDown, paramsOf } from '../lib/liveJson.js';

const router = Router();

export const ZONES = [
  { bzn: 'DE-LU', names: ['de-lu', 'germany', 'german', 'deutschland', 'de', 'luxembourg'] },
  { bzn: 'FR', names: ['fr', 'france', 'french'] },
  { bzn: 'NL', names: ['nl', 'netherlands', 'dutch', 'holland'] },
  { bzn: 'BE', names: ['be', 'belgium'] },
  { bzn: 'AT', names: ['at', 'austria'] },
  { bzn: 'CH', names: ['ch', 'switzerland'] },
  { bzn: 'PL', names: ['pl', 'poland'] },
  { bzn: 'ES', names: ['es', 'spain'] },
  { bzn: 'PT', names: ['pt', 'portugal'] },
  { bzn: 'IT-North', names: ['it', 'it-north', 'italy', 'italian'] },
  { bzn: 'DK1', names: ['dk1', 'denmark', 'dk'] },
  { bzn: 'DK2', names: ['dk2'] },
  { bzn: 'NO2', names: ['no2', 'norway', 'no'] },
  { bzn: 'SE4', names: ['se4', 'sweden', 'se'] },
  { bzn: 'FI', names: ['fi', 'finland'] },
  { bzn: 'CZ', names: ['cz', 'czech', 'czechia'] },
  { bzn: 'HU', names: ['hu', 'hungary'] },
];

export function resolveZone(value, text) {
  const hay = ` ${String(value ?? '')} ${String(text ?? '')} `.toLowerCase();
  const word = String(value ?? '').trim().toLowerCase();
  for (const z of ZONES) if (z.bzn.toLowerCase() === word || z.names.includes(word)) return z;
  for (const z of ZONES) for (const n of z.names) if (n.length > 3 && hay.includes(` ${n}`)) return z;
  return null;
}

export function summarisePrices(unix, price, nowSec) {
  const pts = unix.map((t, i) => ({ t, p: price[i] })).filter((x) => Number.isFinite(x.p));
  if (!pts.length) return null;
  let current = pts[0];
  for (const x of pts) if (x.t <= nowSec) current = x;
  const vals = pts.map((x) => x.p);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { current, min: Math.min(...vals), max: Math.max(...vals), avg, points: pts.length };
}

async function handle(req, res) {
  const params = paramsOf(req);
  const raw = firstUsableValue(params.zone, params.bzn, params.region, params.country, params.market, params.area);
  const text = freeTextParam(params);
  const zone = resolveZone(raw, text);
  if (!zone) {
    return respondUnusableInput(res, `${quoteParam(raw ?? text)} is not a grid zone I cover. I cover day-ahead prices for: ${ZONES.map((z) => z.bzn).join(', ')}. US operators (ERCOT, PJM, CAISO) are not covered.`);
  }
  const day = new Date().toISOString().slice(0, 10);
  let data;
  try {
    data = await getJson(`https://api.energy-charts.info/price?bzn=${encodeURIComponent(zone.bzn)}&start=${day}&end=${day}`);
  } catch (err) {
    return upstreamDown(res, 'The grid price source', err);
  }
  const s = summarisePrices(data.unix_seconds ?? [], data.price ?? [], Math.floor(Date.now() / 1000));
  if (!s) return upstreamDown(res, 'The grid price source (no prices published for today yet)', 'empty series');
  const r = (n) => Number(n.toFixed(2));
  const at = new Date(s.current.t * 1000).toISOString();
  res.json({
    status: 'ok',
    summary: `Day-ahead electricity price in ${zone.bzn} at ${at.slice(0, 16).replace('T', ' ')} UTC is ${r(s.current.p)} EUR/MWh (${r(s.current.p / 10)} EUR cents/kWh). Today ranges ${r(s.min)} to ${r(s.max)} EUR/MWh, average ${r(s.avg)}.`,
    confidence: 0.9,
    canonical: `grid-power-price:${zone.bzn}:${day}`,
    zone: zone.bzn,
    price_eur_per_mwh: r(s.current.p),
    price_time: at,
    day_min_eur_per_mwh: r(s.min),
    day_max_eur_per_mwh: r(s.max),
    day_avg_eur_per_mwh: r(s.avg),
    market: 'day-ahead',
    source: 'Energy-Charts (ENTSO-E / Bundesnetzagentur)',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
