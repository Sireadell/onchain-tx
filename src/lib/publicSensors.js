// Live readings from public sensor networks, read by the id or place a
// question names. No keys.
// - USGS Water Services instantaneous values (river gauges, by site number)
// - PEGELONLINE (German federal waterways gauges, by uuid, number or name)
// - NWS station observations (US weather stations, by ICAO id such as KSFO)
// - Sensor.Community (citizen air-quality sensors, by numeric sensor id)

const UA = { 'User-Agent': 'txlens-sensor-check/1.0', Accept: 'application/json' };

async function getJson(url, timeoutMs = 9000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const STOP = new Set(['Is', 'Can', 'The', 'What', 'Has', 'Does', 'Are', 'Confirm', 'Verify', 'PEGELONLINE', 'UUID', 'ID', 'USGS', 'HMAC', 'Say', 'Hi', 'Please', 'Check', 'Station', 'Sensor', 'Water', 'Level', 'German', 'Germany', 'River', 'Dam', 'Gauge', 'Pegel', 'WSV', 'MQTT']);

export function findPublicSensor(text) {
  const t = String(text ?? '');
  const usgs = t.match(/\bUSGS[\s_-]*(?:site|station|gauge|gage)?[\s#:_-]*(?:no\.?\s*)?(\d{8,15})\b/i)
    || t.match(/\b(?:site|station|gauge|gage)\s*(?:no\.?|number|id)?\s*[#:]?\s*(\d{8,15})\b(?=[^.]*\busgs\b)/i)
    || (/\busgs\b/i.test(t) && t.match(/\b(\d{8,15})\b/));
  if (usgs) return { kind: 'usgs', id: usgs[1] };
  const icao = t.match(/\b(?:station|airport|asos|awos|nws|metar)\s*(?:id\s*)?[:(]?\s*([KP][A-Z]{3})\b/) || t.match(/\b([KP][A-Z]{3})\b(?=[^.]*\b(?:nws|asos|metar|weather station)\b)/);
  if (icao) return { kind: 'nws', id: icao[1] };
  const sc = t.match(/\bsensor\.?community\b[^.]*?\b(\d{3,7})\b/i) || t.match(/\b(\d{3,7})\b[^.]*\bsensor\.?community\b/i);
  if (sc) return { kind: 'sensorcommunity', id: sc[1] };
  const pegelish = /pegel|\bwsv\b|rhein|rhine|elbe|donau|danube|mosel|\bmain river|weser|koblenz|german (?:river|waterway)/i.test(t);
  const waterish = /water level|wasserstand|gauge|gage|river|dam\b|weir|lock\b/i.test(t);
  if (pegelish || waterish) {
    const ids = [...new Set([...(t.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []), ...(t.match(/\b\d{7,8}\b/g) ?? [])])];
    const names = [...new Set((t.match(/\b[A-ZÄÖÜ][a-zäöüß]{3,}(?:[- ][A-ZÄÖÜ][a-zäöüß]{3,})?\b/g) ?? []).filter((w) => !STOP.has(w.split(/[- ]/)[0])))];
    if (pegelish || ids.length || names.length) return { kind: 'pegel', ids, names: names.slice(0, 3), strong: pegelish };
  }
  return null;
}

function pickUsgsSeries(series, text) {
  const want = /discharge|streamflow|flow/i.test(text) ? /streamflow|discharge/i
    : /gage height|gauge height|stage|water level|level/i.test(text) ? /gage height/i
      : /temperature|temp\b/i.test(text) ? /temperature/i
        : null;
  const live = series.filter((s) => s.latest);
  const byName = want ? live.filter((s) => want.test(s.name)) : [];
  if (byName.length) return { chosen: byName[0], matched: true };
  live.sort((a, b) => b.latest.t - a.latest.t);
  return { chosen: live[0] ?? null, matched: !want };
}

const USGS_CODES = {
  '00060': 'Streamflow (discharge)', '00065': 'Gage height', '00010': 'Water temperature', '00300': 'Dissolved oxygen',
  '00095': 'Specific conductance', '00400': 'pH', '63680': 'Turbidity', '62620': 'Water level elevation (NAVD88)',
  '63160': 'Water level elevation (NAVD88)', '00045': 'Precipitation', '00020': 'Air temperature', '72019': 'Depth to water level',
};

// The newer USGS Water Data service: latest value of every series at a site.
async function readUsgsOgc(id, text) {
  const j = await getJson(`https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?monitoring_location_id=USGS-${encodeURIComponent(id)}&f=json&limit=50`, 12000);
  const feats = j?.features ?? [];
  if (!feats.length) return { found: false, source: 'USGS Water Data', id };
  const series = feats.map((f) => f.properties).filter((p) => p && p.value != null && p.time).map((p) => ({
    name: USGS_CODES[p.parameter_code] ?? `Parameter ${p.parameter_code}`,
    unit: String(p.unit_of_measure ?? '').replace(/^_/, ''),
    latest: { value: Number(p.value), t: Date.parse(p.time) },
    approval: p.approval_status,
  })).sort((a, b) => b.latest.t - a.latest.t);
  const { chosen, matched } = pickUsgsSeries(series, text);
  if (!chosen) return { found: false, source: 'USGS Water Data', id };
  return {
    found: true,
    source: 'USGS Water Data (api.waterdata.usgs.gov, latest continuous values)',
    id: `USGS-${id}`,
    site_name: null,
    metric: chosen.name,
    unit: chosen.unit,
    value: chosen.latest.value,
    observed_at: new Date(chosen.latest.t).toISOString(),
    metric_matched: matched,
    other_series: series.filter((s) => s !== chosen && Date.now() - s.latest.t < 2 * 86400e3).slice(0, 4).map((s) => ({ metric: s.name, value: s.latest.value, unit: s.unit })),
  };
}

export async function readUsgs(id, text) {
  const withData = (p) => p.then((r) => (r?.found ? r : Promise.reject(new Error('no data'))));
  try {
    return await Promise.any([withData(readUsgsOgc(id, text)), withData(readUsgsLegacy(id, text))]);
  } catch {
    return { found: false, source: 'USGS Water Services and Water Data', id };
  }
}

async function readUsgsLegacy(id, text) {
  const url =`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${encodeURIComponent(id)}&siteStatus=all`;
  const j = await getJson(url, 12000).catch((err) => (err.status === 404 || err.status === 400 ? null : getJson(url, 10000)));
  if (!j) return { found: false, source: 'USGS Water Services', id };
  const ts = j?.value?.timeSeries ?? [];
  if (!ts.length) return { found: false, source: 'USGS Water Services', id };
  const decode = (s) => String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const series = ts.map((s) => {
    const v = s.values?.[0]?.value ?? [];
    const last = v.at(-1);
    return {
      name: decode(s.variable?.variableName ?? ''),
      unit: decode(s.variable?.unit?.unitCode ?? ''),
      latest: last ? { value: Number(last.value), t: Date.parse(last.dateTime), raw: last.dateTime } : null,
      noData: s.variable?.noDataValue,
    };
  });
  const { chosen, matched } = pickUsgsSeries(series, text);
  return {
    found: true,
    source: 'USGS Water Services (waterservices.usgs.gov, instantaneous values)',
    id: `USGS-${id}`,
    site_name: ts[0].sourceInfo?.siteName ?? null,
    metric: chosen?.name ?? null,
    unit: chosen?.unit ?? null,
    value: chosen?.latest?.value ?? null,
    observed_at: chosen?.latest ? new Date(chosen.latest.t).toISOString() : null,
    metric_matched: matched,
    other_series: series.filter((s) => s !== chosen && s.latest).slice(0, 4).map((s) => ({ metric: s.name, value: s.latest.value, unit: s.unit, observed_at: new Date(s.latest.t).toISOString() })),
  };
}

function pegelReading(st) {
  const w = (st.timeseries ?? []).find((x) => x.shortname === 'W') ?? st.timeseries?.[0];
  const m = w?.currentMeasurement;
  return {
    found: true,
    source: 'PEGELONLINE (Federal Waterways and Shipping Administration, pegelonline.wsv.de)',
    id: st.uuid,
    number: st.number,
    site_name: `${st.longname}${st.water?.longname ? ` (${st.water.longname})` : ''}`,
    metric: w ? `${w.longname} (water level)` : null,
    unit: w?.unit ?? null,
    value: m ? Number(m.value) : null,
    observed_at: m ? new Date(m.timestamp).toISOString() : null,
    state: m?.stateMnwMhw ?? null,
    metric_matched: true,
  };
}

export async function readPegel({ ids = [], names = [] }) {
  const base = 'https://www.pegelonline.wsv.de/webservices/rest-api/v2/stations';
  for (const id of ids.slice(0, 3)) {
    try {
      return pegelReading(await getJson(`${base}/${encodeURIComponent(id)}.json?includeTimeseries=true&includeCurrentMeasurement=true`, 7000));
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  for (const n of names) {
    const list = await getJson(`${base}.json?fuzzyId=${encodeURIComponent(n)}&includeTimeseries=true&includeCurrentMeasurement=true`, 7000).catch(() => []);
    if (Array.isArray(list) && list.length) {
      const exact = list.find((s) => s.longname?.toLowerCase() === n.toLowerCase() || s.shortname?.toLowerCase() === n.toLowerCase()) ?? list[0];
      return { ...pegelReading(exact), matched_by_name: n, tried_ids: ids };
    }
  }
  return { found: false, source: 'PEGELONLINE', tried_ids: ids, tried_names: names };
}

export async function readNws(icao) {
  const j = await getJson(`https://api.weather.gov/stations/${encodeURIComponent(icao)}/observations/latest`);
  const p = j?.properties ?? {};
  return {
    found: true,
    source: 'US National Weather Service (api.weather.gov)',
    id: icao,
    site_name: p.stationName ?? icao,
    metric: 'Air temperature',
    unit: 'C',
    value: p.temperature?.value ?? null,
    observed_at: p.timestamp ? new Date(p.timestamp).toISOString() : null,
    metric_matched: true,
    other_series: [
      { metric: 'Relative humidity', value: p.relativeHumidity?.value ?? null, unit: '%' },
      { metric: 'Barometric pressure', value: p.barometricPressure?.value ?? null, unit: 'Pa' },
    ],
  };
}

export async function readSensorCommunity(id) {
  const j = await getJson(`https://data.sensor.community/airrohr/v1/sensor/${encodeURIComponent(id)}/`);
  if (!Array.isArray(j) || !j.length) return { found: false, source: 'Sensor.Community', id };
  const last = j.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).at(-1);
  const vals = Object.fromEntries((last.sensordatavalues ?? []).map((v) => [v.value_type, Number(v.value)]));
  const [metric, value] = Object.entries(vals)[0] ?? [null, null];
  return {
    found: true,
    source: 'Sensor.Community (data.sensor.community)',
    id,
    site_name: `${last.sensor?.sensor_type?.name ?? 'sensor'} ${id}`,
    metric,
    unit: /^P[12]$/.test(metric ?? '') ? 'µg/m3' : metric === 'temperature' ? 'C' : metric === 'humidity' ? '%' : null,
    value,
    observed_at: last.timestamp ? new Date(`${last.timestamp.replace(' ', 'T')}Z`).toISOString() : null,
    metric_matched: true,
    other_series: Object.entries(vals).slice(1).map(([k, v]) => ({ metric: k, value: v })),
  };
}

export async function readPublicSensor(found, text) {
  if (found.kind === 'usgs') return readUsgs(found.id, text);
  if (found.kind === 'nws') return readNws(found.id);
  if (found.kind === 'sensorcommunity') return readSensorCommunity(found.id);
  if (found.kind === 'pegel') return readPegel(found);
  return { found: false };
}

// "within the last hour", "less than 30 seconds old", "older than 90 seconds
// are stale", "last 24 hours", "within the last 15 minutes".
export function freshnessWindowSeconds(text) {
  const t = String(text ?? '');
  const m = t.match(/(?:last|past|within|older than|less than|under|no more than)\s+(?:the\s+)?(?:last\s+)?(\d+|an?|one)?\s*(seconds?|secs?|s\b|minutes?|mins?|hours?|hrs?|h\b|days?)/i);
  if (!m) return null;
  const n = m[1] && /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const u = m[2].toLowerCase();
  const mult = u.startsWith('s') ? 1 : u.startsWith('m') ? 60 : u.startsWith('h') ? 3600 : 86400;
  return n * mult;
}
