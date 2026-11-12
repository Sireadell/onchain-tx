// LIVE_PORT_CONGESTION: vessels currently in port, arrivals expected in the
// next 24 hours and average berth stay so far, for Finnish ports, from
// Digitraffic port calls (open, no key). Ports elsewhere are named as not
// covered, because the global feeds need paid keys. "In port" means the
// port call has an actual arrival (ata) and no actual departure (atd).

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { getJson, upstreamDown, paramsOf } from '../lib/liveJson.js';

const router = Router();

export const PORTS = {
  FIHEL: ['helsinki', 'hel'], FITKU: ['turku', 'tku'], FIHKO: ['hamina', 'kotka', 'hamina-kotka', 'hko'],
  FIRAU: ['rauma'], FIPOR: ['pori'], FIKOK: ['kokkola'], FIOUL: ['oulu'], FIKEM: ['kemi'],
  FIUKI: ['kaskinen'], FIVAA: ['vaasa'], FINLI: ['naantali'], FIPRS: ['porvoo'], FIKTK: ['kotka'],
};

export function resolvePort(value, text) {
  const raw = String(firstUsableValue(value) ?? '').trim().toLowerCase();
  const hay = ` ${raw} ${String(text ?? '').toLowerCase()} `;
  for (const [code, names] of Object.entries(PORTS)) {
    if (raw === code.toLowerCase() || hay.includes(` ${code.toLowerCase()} `)) return code;
    for (const n of names) if (n.length > 3 && hay.includes(n)) return code;
  }
  return null;
}

export function congestion(portCalls, code, nowMs) {
  let inPort = 0;
  let expected = 0;
  let departed = 0;
  let overdue = 0;
  const stays = [];
  for (const c of portCalls) {
    if (c.portToVisit !== code) continue;
    for (const a of c.portAreaDetails ?? []) {
      const ata = a.ata ? Date.parse(a.ata) : null;
      const atd = a.atd ? Date.parse(a.atd) : null;
      const eta = a.eta ? Date.parse(a.eta) : null;
      const etd = a.etd ? Date.parse(a.etd) : null;
      // A call with no departure report whose planned departure passed more
      // than 12 hours ago is a stale record, not a ship still alongside.
      const stale = etd != null && etd < nowMs - 12 * 3.6e6;
      if (atd && atd <= nowMs && atd >= nowMs - 24 * 3.6e6) departed += 1;
      if (ata && !atd && !stale) { inPort += 1; stays.push((nowMs - ata) / 3.6e6); }
      else if (!ata && eta && eta >= nowMs && eta <= nowMs + 24 * 3.6e6) expected += 1;
      else if (!ata && !atd && eta && eta < nowMs && eta >= nowMs - 24 * 3.6e6) overdue += 1;
    }
  }
  const avg = stays.length ? stays.reduce((a, b) => a + b, 0) / stays.length : 0;
  return { inPort, expected, departed, overdue, avgStayHours: avg };
}

// Rule of thumb for Finnish ports, not a published scale: ships in port plus
// ships due within a day. Under 10 is low, under 25 moderate, otherwise high.
export function congestionLevel(inPort, expected) {
  const load = inPort + expected;
  return load < 10 ? 'low' : load < 25 ? 'moderate' : 'high';
}

async function handle(req, res) {
  const params = paramsOf(req);
  const raw = firstUsableValue(params.port, params.locode, params.port_name, params.harbor);
  const code = resolvePort(raw, freeTextParam(params));
  if (!code) {
    const text = freeTextParam(params);
    const named = text?.match(/(?:\b[Pp]ort of|\b(?:at|in|for))\s+(?:the\s+)?(?:[Pp]ort of\s+)?([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?)/)?.[1];
    const asked = String(raw ?? named ?? 'That port').trim().slice(0, 80) || 'That port';
    return res.json({
      summary: `${asked} is outside the open port-call register this service reads, which covers Finnish ports only (Helsinki, Turku, Hamina-Kotka, Rauma, Pori, Kokkola, Oulu, Kemi, Kaskinen, Vaasa, Naantali, Porvoo), so no berth or queue figures are given rather than estimated.`,
      status: 'not_found',
      found: false,
      confidence: 0.6,
      canonical: `port-congestion:${asked.toLowerCase()}`,
      port: asked,
      vessels_in_port: null,
      arrivals_expected_24h: null,
      departed_24h: null,
      avg_stay_hours_so_far: null,
      congestion_level: null,
      reason: 'Port is not in the Finnish port-call register.',
      covered_ports: Object.keys(PORTS),
      source: 'Digitraffic port calls (Fintraffic)',
      checked_at: new Date().toISOString(),
    });
  }
  const from = new Date(Date.now() - 14 * 86400e3).toISOString();
  let data;
  try {
    data = await getJson(`https://meri.digitraffic.fi/api/port-call/v1/port-calls?locode=${code}&from=${encodeURIComponent(from)}`, { timeoutMs: 20000 });
  } catch (err) {
    return upstreamDown(res, 'The port call source', err);
  }
  const c = congestion(data.portCalls ?? [], code, Date.now());
  const level = congestionLevel(c.inPort, c.expected);
  res.json({
    summary: `${code} has ${c.inPort} vessels in port, ${c.expected} more expected within 24 hours and ${c.departed} departed in the last 24 hours; vessels now in port have stayed ${c.avgStayHours.toFixed(1)} hours on average so far.${c.overdue ? ` ${c.overdue} more were due in the last 24 hours with no arrival reported yet (possibly waiting off the port).` : ''} Congestion is ${level}.`,
    status: 'ok',
    found: true,
    congestion_level: level,
    confidence: 0.75,
    canonical: `port-congestion:${code}`,
    port: code,
    vessels_in_port: c.inPort,
    arrivals_expected_24h: c.expected,
    departed_24h: c.departed,
    waiting_at_anchor: c.overdue,
    avg_stay_hours_so_far: Number(c.avgStayHours.toFixed(1)),
    source: 'Digitraffic port calls (Fintraffic)',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
