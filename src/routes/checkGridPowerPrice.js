// GRID_POWER_PRICE: wholesale electricity price for the place and time the
// question names.
// - California (CAISO): day-ahead hourly and real-time 5-minute LMP with its
//   energy, congestion, loss and greenhouse-gas parts, from CAISO OASIS (the
//   operator's own public service, no key).
// - Estonia, Finland, Latvia, Lithuania: Nord Pool day-ahead prices as
//   published by Elering (Estonia's grid operator, no key).
// - Other European bidding zones: day-ahead prices from Energy-Charts
//   (Fraunhofer ISE, data from ENTSO-E, no key).
// ERCOT, PJM, MISO, NYISO, SPP and ISO-NE need registered keys or block
// automated reads, so those questions get a plain "not covered" with the
// requested fields left empty rather than a guessed price.

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { getJson, upstreamDown, paramsOf } from '../lib/liveJson.js';
import { parseWhen, zoneOf } from '../lib/whenParse.js';
import { isCaisoQuestion, caisoNode, fetchCaisoLmp } from '../lib/caisoOasis.js';

const router = Router();

export const ZONES = [
  { bzn: 'DE-LU', names: ['de-lu', 'germany', 'german', 'deutschland', 'de', 'luxembourg', 'epex'] },
  { bzn: 'FR', names: ['fr', 'france', 'french'] },
  { bzn: 'NL', names: ['nl', 'netherlands', 'dutch', 'holland', 'apx'] },
  { bzn: 'BE', names: ['be', 'belgium', 'belgian', 'belpex'] },
  { bzn: 'AT', names: ['at', 'austria'] },
  { bzn: 'CH', names: ['ch', 'switzerland', 'swiss'] },
  { bzn: 'PL', names: ['pl', 'poland', 'polish'] },
  { bzn: 'ES', names: ['es', 'spain', 'spanish', 'omie'] },
  { bzn: 'PT', names: ['pt', 'portugal'] },
  { bzn: 'IT-North', names: ['it', 'it-north', 'italy', 'italian'] },
  { bzn: 'DK1', names: ['dk1', 'denmark', 'dk'] },
  { bzn: 'DK2', names: ['dk2'] },
  { bzn: 'NO2', names: ['no2', 'norway', 'no'] },
  { bzn: 'SE4', names: ['se4', 'sweden', 'se'] },
  { bzn: 'SE3', names: ['se3'] },
  { bzn: 'FI', names: ['fi', 'finland', 'finnish'], elering: 'fi' },
  { bzn: 'EE', names: ['ee', 'estonia', 'estonian', 'elering'], elering: 'ee' },
  { bzn: 'LV', names: ['lv', 'latvia'], elering: 'lv' },
  { bzn: 'LT', names: ['lt', 'lithuania'], elering: 'lt' },
  { bzn: 'CZ', names: ['cz', 'czech', 'czechia'] },
  { bzn: 'HU', names: ['hu', 'hungary'] },
];

// Two-letter codes only count when written as a code: in capitals in the
// question ("Elering FI zone"), or as the whole parameter value.
export function resolveZone(value, text) {
  const word = String(value ?? '').trim().toLowerCase();
  for (const z of ZONES) if (z.bzn.toLowerCase() === word || z.names.includes(word)) return z;
  const original = ` ${String(value ?? '')} ${String(text ?? '')} `;
  const hay = original.toLowerCase();
  const codeHit = (code) => new RegExp(`(^|[^A-Za-z])${code.toUpperCase()}([^A-Za-z]|$)`).test(original);
  for (const z of ZONES) if (/^[A-Z]{2}\d$|^[A-Z]{2}-/.test(z.bzn) && codeHit(z.bzn)) return z;
  for (const z of ZONES) if (z.bzn.length === 2 && new RegExp(`(^|[^A-Za-z])${z.bzn}\\s+(zone|bidding|area|price|region)`).test(original)) return z;
  for (const z of ZONES) for (const n of z.names) if (n.length > 3 && new RegExp(`(^|[^a-z])${n}([^a-z]|$)`).test(hay)) return z;
  for (const z of ZONES) if (z.bzn.length === 2 && codeHit(z.bzn) && !/^(IT|AT|BE|NO|DE|ES|PT)$/.test(z.bzn)) return z;
  for (const z of ZONES) if (z.bzn.length === 2 && new RegExp(`(^|[^A-Za-z])${z.bzn}\\s+(zone|bidding|area|price|region)`, 'i').test(original)) return z;
  return null;
}

const OTHER_US = [
  { iso: 'PJM', re: /\bpjm\b/i, why: 'PJM Data Miner needs a registered PJM API key' },
  { iso: 'MISO', re: /\bmiso\b/i, why: 'MISO prices are not yet read by this service' },
  { iso: 'NYISO', re: /\bnyiso\b|new york iso/i, why: 'NYISO prices are not yet read by this service' },
  { iso: 'SPP', re: /\bspp\b|southwest power pool/i, why: 'SPP prices are not yet read by this service' },
  { iso: 'ERCOT', re: /\bercot\b|\btexas\b|houston hub|north hub|west hub|south hub/i, why: 'ERCOT blocks automated reads of its public price pages; its data API needs a registered (free) ERCOT developer key' },
  { iso: 'ISO-NE', re: /\biso[- ]?ne\b|new england/i, why: 'ISO-NE web services need a registered account' },
];

export function summarisePrices(unix, price, nowSec) {
  const pts = unix.map((t, i) => ({ t, p: price[i] })).filter((x) => Number.isFinite(x.p));
  if (!pts.length) return null;
  let current = pts[0];
  for (const x of pts) if (x.t <= nowSec) current = x;
  const vals = pts.map((x) => x.p);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { current, min: Math.min(...vals), max: Math.max(...vals), avg, points: pts.length };
}

const r2 = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : null);
const iso16 = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function wantsMarkets(text) {
  const rt = /real[- ]?time|\brtm\b|\brt\b|5[- ]?min|spot price now/i.test(text);
  const da = /day[- ]?ahead|\bdam\b|\bda\b/i.test(text);
  if (rt && da) return ['DAM', 'RTM'];
  if (rt) return ['RTM'];
  return ['DAM'];
}

function sumParts(rows) {
  const pick = (k) => r2(mean(rows.map((x) => x[k]).filter(Number.isFinite)));
  return { lmp: pick('LMP'), energy: pick('MCE'), congestion: pick('MCC'), loss: pick('MCL'), ghg: pick('MGHG') };
}

async function caisoAnswer(res, text, fetchImpl) {
  const node = caisoNode(text);
  const tzText = zoneOf(text) ? text : `${text} PT`;
  const when = parseWhen(tzText) ?? null;
  const markets = wantsMarkets(text);
  const now = Date.now();
  let start;
  let end;
  let scope;
  if (when?.hasHour) {
    start = when.at;
    end = new Date(start.getTime() + 3600e3);
    scope = when.ending ? `hour ending ${iso16(end).slice(11)} UTC` : `hour starting ${iso16(start).slice(11)} UTC`;
  } else if (when?.hasDate) {
    start = when.at; // midnight Pacific of that day
    end = new Date(start.getTime() + 24 * 3600e3);
    scope = 'operating day (Pacific time)';
  } else {
    const h = new Date(now);
    h.setUTCMinutes(0, 0, 0);
    start = markets.includes('RTM') && markets.length === 1 ? new Date(now - 3600e3) : h;
    end = markets.includes('RTM') && markets.length === 1 ? new Date(now) : new Date(h.getTime() + 3600e3);
    scope = 'latest published interval';
  }
  let futureNote = '';
  if (markets.includes('RTM') && start.getTime() > now) {
    futureNote = ` The real-time interval asked about (${iso16(start)} UTC) has not happened yet, so the day-ahead price already cleared for it is given, with the latest real-time interval.`;
    if (!markets.includes('DAM')) markets.unshift('DAM');
  }
  const results = {};
  for (const m of markets) {
    if (m === 'RTM' && start.getTime() > now) {
      try {
        results[m] = await fetchCaisoLmp({ market: m, node: node.node, start: new Date(now - 3600e3), end: new Date(now), fetchImpl });
        results[m].intervals = results[m].intervals.slice(-1);
      } catch (err) {
        results[m] = { intervals: [], error: String(err.message ?? err) };
      }
      continue;
    }
    try {
      results[m] = await fetchCaisoLmp({ market: m, node: node.node, start, end, fetchImpl });
    } catch (err) {
      results[m] = { intervals: [], error: String(err.message ?? err) };
    }
  }
  const lines = [];
  const out = {};
  for (const m of markets) {
    const rows = results[m].intervals;
    if (!rows.length) {
      lines.push(`${m === 'DAM' ? 'Day-ahead' : 'Real-time'}: CAISO OASIS returned no prices for ${node.node} in that interval (${results[m].error ?? 'no data'}).`);
      continue;
    }
    const useRows = scope === 'latest published interval' && m === 'RTM' ? rows.slice(-1) : rows;
    const p = sumParts(useRows);
    const peak = rows.length > 1 ? Math.max(...rows.map((x) => x.LMP).filter(Number.isFinite)) : null;
    out[m] = { ...p, interval_start: useRows[0].start, interval_end: useRows.at(-1).end, intervals: useRows.length, peak_lmp: r2(peak) };
    const label = m === 'DAM' ? 'Day-ahead' : 'Real-time';
    const span = useRows.length > 1 ? `average of ${useRows.length} ${m === 'DAM' ? 'hourly' : '5-minute'} intervals ${useRows[0].start.slice(0, 16)} to ${useRows.at(-1).end.slice(0, 16)} UTC` : `interval ${useRows[0].start.slice(0, 16)} to ${useRows[0].end.slice(0, 16)} UTC`;
    lines.push(`${label} LMP ${p.lmp} USD/MWh (${span}): energy ${p.energy}, congestion ${p.congestion}, losses ${p.loss}${p.ghg != null ? `, greenhouse gas ${p.ghg}` : ''}${peak != null && useRows.length > 1 ? `; highest interval ${r2(peak)}` : ''}.`);
  }
  const primary = out[markets[0]] ?? out.DAM ?? out.RTM;
  if (!primary) {
    return res.json({
      status: 'not_found', found: false, confidence: 0.4,
      summary: `CAISO ${node.label} (${node.node}), ${scope}: ${lines.join(' ')} No price is given rather than estimated.`,
      iso: 'CAISO', node_or_zone: node.node, market: markets.join('+'), currency: 'USD', lmp_usd_per_mwh: null,
      interval_start: start.toISOString(), source: 'CAISO OASIS', checked_at: new Date().toISOString(),
    });
  }
  let spread = '';
  if (out.DAM && out.RTM) {
    const d = r2(out.RTM.lmp - out.DAM.lmp);
    spread = ` Real-time was ${Math.abs(d)} USD/MWh ${d >= 0 ? 'above' : 'below'} day-ahead${out.RTM.peak_lmp != null && out.RTM.peak_lmp > out.DAM.lmp * 1.5 ? `, with a 5-minute peak of ${out.RTM.peak_lmp}, so real-time did spike` : ', so there was no large real-time spike'}.`;
  }
  const nodeNote = node.named ? '' : ' No node was named, so the NP15 trading hub is used.';
  return res.json({
    status: 'ok',
    found: true,
    summary: `CAISO ${node.label} (${node.node}), ${scope}. ${lines.join(' ')}${spread}${futureNote}${nodeNote} Source: CAISO OASIS.`,
    confidence: 0.92,
    canonical: `grid-power-price:caiso:${node.node}:${markets.join('+')}:${primary.interval_start}`,
    iso: 'CAISO',
    market: markets.length > 1 ? 'DAM+RTM' : markets[0],
    node_or_zone: node.node,
    currency: 'USD',
    lmp_usd_per_mwh: primary.lmp,
    price_usd_per_mwh: primary.lmp,
    price_usd_per_kwh: Number((primary.lmp / 1000).toFixed(5)),
    interval_start: primary.interval_start,
    interval_end: primary.interval_end,
    components_usd_per_mwh: { energy: primary.energy, congestion: primary.congestion, loss: primary.loss, greenhouse_gas: primary.ghg },
    day_ahead: out.DAM ?? null,
    real_time: out.RTM ?? null,
    unavailable: markets.filter((m) => !out[m]),
    source: 'CAISO OASIS (oasis.caiso.com), PRC_LMP and PRC_INTVL_LMP',
    checked_at: new Date().toISOString(),
  });
}

function pickPoint(pts, when) {
  if (!pts.length) return null;
  if (!when?.hasHour) return null;
  const t = when.at.getTime() / 1000;
  let best = null;
  for (const x of pts) if (x.t <= t) best = x;
  return best ?? pts[0];
}

async function europeAnswer(res, zone, text, getJsonImpl) {
  const when = parseWhen(text);
  const nowSec = Math.floor(Date.now() / 1000);
  const day = (when?.at ?? new Date()).toISOString().slice(0, 10);
  let pts;
  let source;
  try {
    if (zone.elering) {
      const s = new Date(`${day}T00:00:00Z`);
      const e = new Date(s.getTime() + 24 * 3600e3);
      const d = await getJsonImpl(`https://dashboard.elering.ee/api/nps/price?start=${s.toISOString()}&end=${e.toISOString()}`);
      pts = (d?.data?.[zone.elering] ?? []).map((x) => ({ t: x.timestamp, p: x.price })).filter((x) => Number.isFinite(x.p) && x.t < e.getTime() / 1000);
      source = 'Elering (Nord Pool day-ahead, dashboard.elering.ee)';
    } else {
      const url = `https://api.energy-charts.info/price?bzn=${encodeURIComponent(zone.bzn)}&start=${day}&end=${day}`;
      const d = await getJsonImpl(url, { timeoutMs: 12000 }).catch(async () => { await new Promise((r) => setTimeout(r, 1500)); return getJsonImpl(url, { timeoutMs: 12000 }); });
      pts = (d.unix_seconds ?? []).map((t, i) => ({ t, p: d.price?.[i] })).filter((x) => Number.isFinite(x.p));
      source = 'Energy-Charts (ENTSO-E day-ahead)';
    }
  } catch (err) {
    return upstreamDown(res, 'The grid price source', err);
  }
  if (!pts.length) return upstreamDown(res, `The grid price source (no ${zone.bzn} prices published for ${day})`, 'empty series');
  const s = summarisePrices(pts.map((x) => x.t), pts.map((x) => x.p), when?.hasDate && !when.hasHour ? Infinity : nowSec);
  const asked = pickPoint(pts, when);
  const point = asked ?? (when?.hasDate && day !== new Date().toISOString().slice(0, 10) ? null : s.current);
  const rt = /real[- ]?time|intraday|imbalance/i.test(text);
  const at = point ? new Date(point.t * 1000).toISOString() : null;
  const head = point
    ? `Day-ahead electricity price in ${zone.bzn} for ${iso16(at)} UTC is ${r2(point.p)} EUR/MWh (${r2(point.p / 10)} EUR cents/kWh).`
    : `Day-ahead electricity prices in ${zone.bzn} on ${day}: average ${r2(s.avg)} EUR/MWh.`;
  const rtNote = rt ? ' A real-time or imbalance price is not published openly for this zone; this is the day-ahead price for the same interval.' : '';
  res.json({
    status: 'ok',
    found: true,
    summary: `${head} That day ranges ${r2(s.min)} to ${r2(s.max)} EUR/MWh, average ${r2(s.avg)} (${s.points} intervals).${rtNote} Source: ${source}.`,
    confidence: 0.9,
    canonical: `grid-power-price:${zone.bzn}:${at ?? day}`,
    zone: zone.bzn,
    node_or_zone: zone.bzn,
    market: 'day-ahead',
    currency: 'EUR',
    price_eur_per_mwh: point ? r2(point.p) : r2(s.avg),
    price_time: at,
    interval_start: at ?? `${day}T00:00:00Z`,
    day_min_eur_per_mwh: r2(s.min),
    day_max_eur_per_mwh: r2(s.max),
    day_avg_eur_per_mwh: r2(s.avg),
    source,
    checked_at: new Date().toISOString(),
  });
}

export async function handle(req, res, { fetchImpl = fetch, getJsonImpl = getJson } = {}) {
  const params = paramsOf(req);
  const raw = firstUsableValue(params.zone, params.bzn, params.region, params.country, params.market, params.area, params.node);
  const text = [freeTextParam(params), raw].filter(Boolean).join(' ');
  if (isCaisoQuestion(text)) return caisoAnswer(res, text, fetchImpl);
  const zone = resolveZone(raw, text);
  if (zone) return europeAnswer(res, zone, text, getJsonImpl);
  const other = OTHER_US.find((o) => o.re.test(text));
  if (other) {
    return res.json({
      status: 'not_found',
      found: false,
      confidence: 0.4,
      summary: `${other.iso} price not available here: ${other.why}. No price is given rather than estimated. Covered: CAISO (day-ahead and real-time, any hub or load area) and European day-ahead zones (${ZONES.map((z) => z.bzn).join(', ')}).`,
      iso: other.iso,
      lmp_usd_per_mwh: null,
      currency: 'USD',
      market: wantsMarkets(text).join('+'),
      node_or_zone: null,
      interval_start: parseWhen(text)?.at?.toISOString() ?? null,
      unavailable: ['lmp_usd_per_mwh'],
      checked_at: new Date().toISOString(),
    });
  }
  return respondUnusableInput(res, `${quoteParam(raw ?? text)} is not a grid zone I cover. I cover CAISO (California hubs and load areas, day-ahead and real-time) and European day-ahead prices for: ${ZONES.map((z) => z.bzn).join(', ')}. ERCOT, PJM and other US operators are not covered.`);
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
