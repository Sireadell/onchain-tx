// LIVE_PORT_CONGESTION: vessels currently in port, arrivals expected in the
// next 24 hours and average berth stay so far, for Finnish ports, from
// Digitraffic port calls (open, no key). Ports elsewhere are named as not
// covered, because the global feeds need paid keys. "In port" means the
// port call has an actual arrival (ata) and no actual departure (atd).

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
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
      if (ata && !atd && !stale) { inPort += 1; stays.push((nowMs - ata) / 3.6e6); }
      else if (!ata && eta && eta >= nowMs && eta <= nowMs + 24 * 3.6e6) expected += 1;
    }
  }
  const avg = stays.length ? stays.reduce((a, b) => a + b, 0) / stays.length : 0;
  return { inPort, expected, avgStayHours: avg };
}

async function handle(req, res) {
  const params = paramsOf(req);
  const raw = firstUsableValue(params.port, params.locode, params.port_name, params.harbor);
  const code = resolvePort(raw, freeTextParam(params));
  if (!code) {
    return respondUnusableInput(res, `${quoteParam(raw ?? freeTextParam(params))} is not a port I cover. I cover Finnish ports: ${Object.keys(PORTS).join(', ')} (or names such as Helsinki, Turku, Hamina-Kotka). Global port feeds need paid keys I do not hold.`);
  }
  const from = new Date(Date.now() - 14 * 86400e3).toISOString();
  let data;
  try {
    data = await getJson(`https://meri.digitraffic.fi/api/port-call/v1/port-calls?locode=${code}&from=${encodeURIComponent(from)}`, { timeoutMs: 20000 });
  } catch (err) {
    return upstreamDown(res, 'The port call source', err);
  }
  const c = congestion(data.portCalls ?? [], code, Date.now());
  res.json({
    status: 'ok',
    summary: `${code} has ${c.inPort} vessels in port and ${c.expected} more expected within 24 hours; vessels now in port have stayed ${c.avgStayHours.toFixed(1)} hours on average so far.`,
    confidence: 0.75,
    canonical: `port-congestion:${code}`,
    port: code,
    vessels_in_port: c.inPort,
    arrivals_expected_24h: c.expected,
    avg_stay_hours_so_far: Number(c.avgStayHours.toFixed(1)),
    source: 'Digitraffic port calls (Fintraffic)',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
