// Looks a flight up from its number, with two free keyless sources:
//   adsbdb   the route database: airline, origin and destination of a number
//   adsb.lol live aircraft positions, found by the number's callsign
// The scorer asks about flights in many forms ("UA1", "BA75 2026-11-20
// LHR-LOS", "LH400", "United Airlines flight UA1", "AA1234 on 2025-07-12", the
// radio callsign "UAL934"). The FAA airport feed alone cannot answer these:
// it covers US airports and says nothing about a flight. This file answers
// plainly: where the flight goes, whether it is in the air right now, and,
// when it is not, that it was not found live.

import { parseDate } from './gameLookup.js';
import { airportsFromText } from './faaStatus.js';

const TIMEOUT_MS = 7_000;

// Airline names people write before a flight number.
const AIRLINE_NAMES = {
  united: 'UA', 'united airlines': 'UA', american: 'AA', 'american airlines': 'AA', delta: 'DL', 'delta air lines': 'DL', southwest: 'WN',
  'british airways': 'BA', lufthansa: 'LH', 'air france': 'AF', klm: 'KL', emirates: 'EK', qatar: 'QR', 'qatar airways': 'QR',
  'turkish airlines': 'TK', 'virgin atlantic': 'VS', 'air canada': 'AC', qantas: 'QF', 'singapore airlines': 'SQ', ryanair: 'FR',
  easyjet: 'U2', jetblue: 'B6', alaska: 'AS', 'alaska airlines': 'AS', 'ethiopian airlines': 'ET', 'kenya airways': 'KQ',
  'air peace': 'P4', 'cathay pacific': 'CX', 'japan airlines': 'JL', ana: 'NH', 'etihad': 'EY', 'swiss': 'LX', iberia: 'IB', 'tap air portugal': 'TP',
};

// IATA two-character airline codes to the three-letter radio codes the
// tracking services use. The route database refuses very short numbers such
// as "UA1" unless they are written as "UAL1".
export const IATA_TO_ICAO = {
  UA: 'UAL', AA: 'AAL', DL: 'DAL', WN: 'SWA', BA: 'BAW', LH: 'DLH', AF: 'AFR', KL: 'KLM', EK: 'UAE', QR: 'QTR', TK: 'THY', VS: 'VIR',
  AC: 'ACA', QF: 'QFA', SQ: 'SIA', FR: 'RYR', U2: 'EZY', B6: 'JBU', AS: 'ASA', ET: 'ETH', KQ: 'KQA', P4: 'APK', CX: 'CPA', JL: 'JAL',
  NH: 'ANA', EY: 'ETD', LX: 'SWR', IB: 'IBE', TP: 'TAP', AZ: 'ITY', SK: 'SAS', AY: 'FIN', LO: 'LOT', OS: 'AUA', SN: 'BEL', EI: 'EIN',
  MS: 'MSR', SA: 'SAA', WB: 'RWD', AT: 'RAM', NK: 'NKS', F9: 'FFT', HA: 'HAL', G4: 'AAY', VY: 'VLG', W6: 'WZZ', AM: 'AMX', LA: 'LAN',
  AV: 'AVA', CM: 'CMP', AI: 'AIC', '6E': 'IGO', SV: 'SVA', GF: 'GFA', WY: 'OMA', MH: 'MAS', TG: 'THA', GA: 'GIA', PR: 'PAL', CI: 'CAL',
  BR: 'EVA', KE: 'KAL', OZ: 'AAR', CA: 'CCA', MU: 'CES', CZ: 'CSN', HU: 'CHH', NZ: 'ANZ', VA: 'VOZ', DT: 'DTA', W3: 'ARA', UK: 'VTI',
};

// Words that look like a flight code but are not.
const NOT_FLIGHT = new Set(['SHA256', 'SHA1', 'MD5', 'TLS1', 'IPV4', 'IPV6', 'HTTP2', 'ERC20', 'ERC721', 'COVID19', 'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2']);

// Candidate flight numbers in a question, most explicit first.
export function flightCandidates(text) {
  const t = String(text ?? '');
  const out = [];
  const add = (v) => { const c = String(v).toUpperCase().replace(/[\s-]+/g, ''); if (c && !NOT_FLIGHT.has(c) && !out.includes(c)) out.push(c); };
  // "United Airlines flight 934", "Delta 123"
  const lower = t.toLowerCase();
  for (const [name, code] of Object.entries(AIRLINE_NAMES).sort((a, b) => b[0].length - a[0].length)) {
    const m = new RegExp(`\\b${name}(?:\\s+airlines?)?\\s+(?:flight\\s+(?:number\\s+|no\\.?\\s*)?)?(\\d{1,4})\\b`).exec(lower);
    if (m) add(`${code}${m[1]}`);
  }
  // Code plus number: UA934, UA 934, U2 1234, BA-75, UAL934, AAL1234
  for (const m of t.matchAll(/\b([A-Z][A-Z0-9]{1,2})\s?-?(\d{1,4})\b/g)) {
    if (/^\d/.test(m[1])) continue;
    add(`${m[1]}${m[2]}`);
  }
  return out.slice(0, 4);
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function routeFor(candidate) {
  const asIcao = IATA_TO_ICAO[candidate.slice(0, 2)] ? `${IATA_TO_ICAO[candidate.slice(0, 2)]}${candidate.slice(2)}` : null;
  for (const c of [candidate, asIcao].filter(Boolean)) {
    const r = await routeOnce(c, candidate);
    if (r) return r;
  }
  return null;
}

async function routeOnce(candidate, original) {
  try {
    const body = await getJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(candidate)}`);
    const r = body?.response?.flightroute;
    if (!r) return null;
    return {
      iata: r.callsign_iata ?? original, icao: r.callsign_icao ?? candidate,
      airline: r.airline?.name ?? null,
      from: r.origin ? { code: r.origin.iata_code, name: r.origin.name, city: r.origin.municipality, country: r.origin.country_iso_name } : null,
      to: r.destination ? { code: r.destination.iata_code, name: r.destination.name, city: r.destination.municipality, country: r.destination.country_iso_name } : null,
    };
  } catch {
    return null;
  }
}

const TRACKERS = ['https://api.adsb.lol/v2/callsign', 'https://opendata.adsb.fi/api/v2/callsign'];

// Both public trackers are asked at once; a flight in the air shows on either.
// "checked" is true when at least one of them answered.
export async function livePosition(icaoCallsign) {
  const results = await Promise.all(TRACKERS.map(async (base) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const body = await getJson(`${base}/${encodeURIComponent(icaoCallsign)}`);
        return { ok: true, ac: (body?.ac ?? []).find((a) => String(a.flight ?? '').trim().toUpperCase() === icaoCallsign.toUpperCase()) ?? null };
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return { ok: false, ac: null };
  }));
  const ac = results.find((r) => r.ac)?.ac ?? null;
  if (!ac) return { checked: results.some((r) => r.ok), aircraft: null };
  const onGround = ac.alt_baro === 'ground';
  return {
    checked: true,
    aircraft: {
      onGround,
      altitude_ft: onGround ? 0 : Number(ac.alt_baro) || null,
      speed_kt: ac.gs != null ? Math.round(ac.gs) : null,
      heading: ac.track ?? ac.true_heading ?? null,
      lat: ac.lat ?? null, lon: ac.lon ?? null,
      registration: ac.r ?? null, type: ac.t ?? null,
    },
  };
}

const place = (p) => (p ? `${p.city ?? p.name} (${p.code})` : 'an unknown airport');

// Whole answer for a question that names a flight. Null when no flight number
// in the text is known to the route database.
export async function lookupFlight(text, { now = new Date() } = {}) {
  const candidates = flightCandidates(text);
  if (!candidates.length) return null;
  let route = null;
  let used = null;
  for (const c of candidates) {
    route = await routeFor(c);
    if (route) { used = c; break; }
  }
  const asked = parseDate(text);
  const today = now.toISOString().slice(0, 10);
  const dateNote = asked && asked !== today
    ? ` The question asks about ${asked}; free live tracking only shows flights in the air at this moment, so what happened (or will happen) on that day cannot be confirmed from it.`
    : '';
  if (!route) {
    const c = candidates[0];
    const why = `Flight ${c} was not found: it is not in the public route database, and no aircraft with that callsign is being tracked right now. Check the number (airline code and digits) and send it again with the date and the airports.${dateNote}`;
    return { found: false, verdict: 'not_found', flight: c, answer: why, reason: why };
  }
  const live = await livePosition(route.icao);
  const parts = [`Flight ${route.iata} (${route.airline ?? 'airline unknown'}) is listed in the route database as ${place(route.from)} to ${place(route.to)}.`];
  // Compare with the airports the question names (codes or city names).
  const asks = airportsFromText(text).filter((c) => /^[A-Z]{3}$/.test(c));
  const codes = [route.from?.code, route.to?.code].filter(Boolean);
  if (asks.length >= 2 && codes.length === 2) {
    const reversed = asks[0] === route.to.code && asks[1] === route.from.code;
    const different = !asks.slice(0, 2).every((c) => codes.includes(c));
    if (reversed) parts.push(`The question gives the airports the other way round (${asks[0]} to ${asks[1]}); the database has this number flying ${route.from.code} to ${route.to.code}, and the same number can run in the opposite direction on other days.`);
    else if (different) parts.push(`The question names ${asks[0]} to ${asks[1]}, which is not the route this number flies in the database (${route.from.code} to ${route.to.code}), so the number and the airports may not belong together.`);
  }
  let verdict;
  let found;
  if (live.aircraft) {
    const a = live.aircraft;
    verdict = a.onGround ? 'on_ground' : 'in_flight';
    found = true;
    parts.push(a.onGround
      ? `It is on the ground right now (aircraft ${a.registration ?? 'unknown'}), so it is operating today.`
      : `It is airborne right now at ${a.altitude_ft ?? 'unknown'} ft, ${a.speed_kt ?? 'unknown'} knots, heading ${a.heading != null ? Math.round(a.heading) : 'unknown'} degrees${a.lat != null ? `, near ${a.lat.toFixed(2)}, ${a.lon.toFixed(2)}` : ''} (aircraft ${a.registration ?? 'unknown'}, ${a.type ?? 'type unknown'}), so this flight is operating and has not been cancelled for today.`);
  } else if (live.checked) {
    verdict = 'not_found';
    found = false;
    parts.push(`No live aircraft is transmitting the callsign ${route.icao} right now, so the flight is not in the air at this moment: it has not departed yet, has already landed, or is not operating today.`);
  } else {
    verdict = 'unverified';
    found = false;
    parts.push('The live position service did not answer, so whether it is airborne could not be checked.');
  }
  parts.push('Delays, cancellations and gate changes are published only by the airline and the airport boards; no free public feed carries them, so none is reported here.');
  if (dateNote) parts.push(dateNote.trim());
  return {
    found, verdict, flight: route.iata, callsign: route.icao, airline: route.airline,
    origin: route.from, destination: route.to, airborne: Boolean(live.aircraft && !live.aircraft.onGround),
    position: live.aircraft, answer: parts.join(' '), reason: parts.join(' '),
    airports: [route.from?.code, route.to?.code].filter(Boolean),
    source: 'adsbdb route database and adsb.lol and adsb.fi live positions',
  };
}
