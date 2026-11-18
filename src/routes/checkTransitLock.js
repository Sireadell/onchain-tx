// TRAVEL_TRANSIT_LOCK_GENERAL signal endpoint. A fare, seat or booking lock
// lives only in the airline's or agency's reservation record, so it is never
// claimed as locked. For a route with airport codes the current METAR flight
// category at each airport is reported from aviationweather.gov, flagging
// instrument conditions that threaten a tight connection.

import { Router } from 'express';
import { firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { airportsFromText } from '../lib/faaStatus.js';

const router = Router();
const now = () => new Date().toISOString();

// Non-US IATA codes to ICAO station ids. Anything else is tried as K + code (US).
const ICAO = {
  LHR: 'EGLL', LGW: 'EGKK', STN: 'EGSS', MAN: 'EGCC', EDI: 'EGPH', DUB: 'EIDW', CDG: 'LFPG', ORY: 'LFPO', FRA: 'EDDF', MUC: 'EDDM', BER: 'EDDB',
  AMS: 'EHAM', BRU: 'EBBR', ZRH: 'LSZH', GVA: 'LSGG', VIE: 'LOWW', MAD: 'LEMD', BCN: 'LEBL', LIS: 'LPPT', FCO: 'LIRF', MXP: 'LIMC', IST: 'LTFM',
  ATH: 'LGAV', CPH: 'EKCH', ARN: 'ESSA', OSL: 'ENGM', HEL: 'EFHK', DXB: 'OMDB', AUH: 'OMAA', DOH: 'OTHH', TLV: 'LLBG', CAI: 'HECA', JNB: 'FAOR',
  CPT: 'FACT', LOS: 'DNMM', NBO: 'HKJK', DEL: 'VIDP', BOM: 'VABB', SIN: 'WSSS', HKG: 'VHHH', BKK: 'VTBS', KUL: 'WMKK', HND: 'RJTT', NRT: 'RJAA',
  KIX: 'RJBB', ICN: 'RKSI', PEK: 'ZBAA', PVG: 'ZSPD', SYD: 'YSSY', MEL: 'YMML', AKL: 'NZAA', YYZ: 'CYYZ', YVR: 'CYVR', YUL: 'CYUL', YYC: 'CYYC',
  MEX: 'MMMX', GRU: 'SBGR', GIG: 'SBGL', EZE: 'SAEZ', BOG: 'SKBO', LIM: 'SPJC', SCL: 'SCEL', HNL: 'PHNL', ANC: 'PANC',
};
const NOT_CODES = new Set(['THE', 'AND', 'FOR', 'ARE', 'ANY', 'HAS', 'WAS', 'ITS', 'NOT', 'USA', 'UTC', 'GMT', 'FAA', 'PNR', 'ETA', 'ETD', 'FARE', 'SEAT', 'HOLD', 'LOCK']);

export function routeCodes(text) {
  const t = String(text ?? '');
  const codes = [];
  const add = (c) => { const u = c.toUpperCase(); if (!NOT_CODES.has(u) && !codes.includes(u)) codes.push(u); };
  for (const m of t.matchAll(/\b([A-Z]{3})\s*(?:-|–|→|>|to|TO)\s*([A-Z]{3})\b/g)) { add(m[1]); add(m[2]); }
  for (const c of airportsFromText(t)) add(c);
  return codes.slice(0, 4);
}

export function bookingRef(text) {
  const m = String(text ?? '').match(/\b(?:booking|reservation|pnr|confirmation|reference|ref|record locator)(?:\s+(?:code|number|no\.?|ref(?:erence)?|id))?\s*(?:is|:|#|-)?\s*([A-Z0-9]{5,8})\b/i);
  if (m && /[A-Z]/i.test(m[1]) && m[1] === m[1].toUpperCase()) return m[1];
  return null;
}

const icaoFor = (code) => ICAO[code] ?? `K${code}`;

async function metars(codes) {
  const ids = codes.map(icaoFor);
  const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${ids.map(encodeURIComponent).join(',')}&format=json`, {
    signal: AbortSignal.timeout(8_000), headers: { 'user-agent': 'txlens-transit/1.0', accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`aviationweather.gov answered HTTP ${res.status}`);
  const list = await res.json();
  return codes.map((code) => {
    const m = (Array.isArray(list) ? list : []).find((x) => x.icaoId === icaoFor(code));
    return m ? { airport: code, station: m.icaoId, flight_category: m.fltCat ?? null, metar: m.rawOb ?? null, observed_at: m.reportTime ?? null } : { airport: code, station: icaoFor(code), flight_category: null, metar: null, observed_at: null };
  });
}

async function handler(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const raw = firstUsableValue(params.query, params.q, params.question, params.text, params.input);
  const extra = firstUsableValue(params.booking, params.route, params.reference, params.pnr);
  const text = [raw, extra].filter(Boolean).join(' ');
  if (!text.trim()) {
    return respondUnusableInput(res, 'No trip was described. Ask about a fare, seat or booking, for example "Is my fare locked for JFK to LHR, booking ABC123?".');
  }
  const codes = routeCodes(text);
  const ref = bookingRef(text);
  const checkedAt = now();
  let conditions = [];
  let weatherNote = '';
  if (codes.length) {
    try {
      conditions = await metars(codes);
    } catch (err) {
      weatherNote = ` Current airport conditions could not be read (${err.message}).`;
    }
  }
  const lock = 'A fare, seat or booking lock exists only in the airline or travel agency reservation record (the booking and its ticketing time limit), which no public source exposes, so whether it is locked, at what price and until when is not reported. The booking confirmation or the airline manage-booking page shows all three.';
  const seen = conditions.filter((c) => c.flight_category);
  const bad = seen.filter((c) => ['IFR', 'LIFR'].includes(c.flight_category));
  let weather = '';
  if (seen.length) {
    weather = ` Current conditions at ${codes.join(' and ')} from aviationweather.gov METAR: ${seen.map((c) => `${c.airport} ${c.flight_category}`).join(', ')}`
      + `${bad.length ? `; ${bad.map((c) => c.airport).join(' and ')} under instrument conditions, which can threaten a tight connection` : '; none under instrument conditions'}.`;
  } else if (codes.length && !weatherNote) {
    weather = ` No current METAR was available for ${codes.join(' and ')}.`;
  }
  const summary = `Unverified: the lock status${ref ? ` of booking ${ref}` : ''}${codes.length > 1 ? ` on ${codes.join(' to ')}` : ''} cannot be confirmed from public data. ${lock}${weather}${weatherNote} Checked ${checkedAt}.`;
  return res.json({
    status: 'ok',
    verdict: 'unverified',
    summary,
    answer: summary,
    confidence: 0.6,
    route: codes.length > 1 ? codes.join(' to ') : null,
    booking_reference: ref,
    locked: null,
    price: null,
    expires_at: null,
    airport_conditions: conditions,
    source: seen.length ? 'aviationweather.gov METAR' : 'none (reservation record is not public)',
    checked_at: checkedAt,
  });
}

router.get('/', handler);
router.post('/', handler);

export default router;
