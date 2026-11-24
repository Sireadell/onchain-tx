// Sentinel-2 scenes and measured spectral indexes for a small box around a
// point, from Microsoft Planetary Computer (public STAC catalogue and its
// statistics service, no key). Indexes are computed from the 10 m and 20 m
// bands on the server:
//   NDVI = (B08 - B04) / (B08 + B04)   green vegetation
//   NDBI = (B11 - B08) / (B11 + B08)   built-up and bare surfaces
//   NDWI = (B03 - B08) / (B03 + B08)   open water
// This is index-level change detection, not object detection: it says
// whether vegetation, built-up surface or water changed, not what was built.

const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const STATS = 'https://planetarycomputer.microsoft.com/api/data/v1/item/statistics';
export const S2_SOURCE = 'Copernicus Sentinel-2 L2A via Microsoft Planetary Computer (STAC catalogue and statistics service)';

const EXPR = ['(B08-B04)/(B08+B04)', '(B11-B08)/(B11+B08)', '(B03-B08)/(B03+B08)'];

async function postJson(url, body, timeoutMs) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function boxAround(lat, lon, km) {
  const dLat = km / 2 / 111.32;
  const dLon = km / 2 / (111.32 * Math.cos((lat * Math.PI) / 180));
  const w = lon - dLon; const e = lon + dLon; const s = lat - dLat; const n = lat + dLat;
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

// Scenes over the point, newest first, inside an optional date window.
export async function searchScenes(lat, lon, { start, end, maxCloud = 30, limit = 6, ascending = false, timeoutMs = 12000 } = {}) {
  const body = {
    collections: ['sentinel-2-l2a'],
    intersects: { type: 'Point', coordinates: [lon, lat] },
    limit,
    sortby: [{ field: 'datetime', direction: ascending ? 'asc' : 'desc' }],
    query: { 'eo:cloud_cover': { lt: maxCloud } },
  };
  if (start || end) body.datetime = `${start ? new Date(start).toISOString() : '..'}/${end ? new Date(end).toISOString() : '..'}`;
  const j = await postJson(STAC, body, timeoutMs);
  return (j.features ?? []).map((f) => ({
    id: f.id,
    datetime: f.properties.datetime,
    cloud_cover: Number(Number(f.properties['eo:cloud_cover']).toFixed(2)),
    platform: f.properties.platform,
    tile: f.properties['s2:mgrs_tile'] ?? null,
  }));
}

export async function sceneIndexes(sceneId, lat, lon, km, { timeoutMs = 15000 } = {}) {
  const q = new URLSearchParams({ collection: 'sentinel-2-l2a', item: sceneId, expression: EXPR.join(';'), asset_as_band: 'true', max_size: '512' });
  const j = await postJson(`${STATS}?${q}`, { type: 'Feature', properties: {}, geometry: boxAround(lat, lon, km) }, timeoutMs);
  const st = j?.properties?.statistics ?? {};
  const pick = (expr) => {
    const k = Object.keys(st).find((x) => x.replace(/\s/g, '') === expr);
    const v = k ? st[k] : null;
    if (!v) return null;
    return { mean: Number(v.mean.toFixed(3)), median: Number(v.median.toFixed(3)), p2: Number(v.percentile_2.toFixed(3)), p98: Number(v.percentile_98.toFixed(3)), pixels: v.valid_pixels };
  };
  return { ndvi: pick(EXPR[0]), ndbi: pick(EXPR[1]), ndwi: pick(EXPR[2]) };
}

export function describeChange(now, before) {
  if (!now?.ndvi || !before?.ndvi) return null;
  const d = (k) => Number(((now[k]?.mean ?? 0) - (before[k]?.mean ?? 0)).toFixed(3));
  const dv = d('ndvi'); const db = d('ndbi'); const dw = d('ndwi');
  const notes = [];
  if (db >= 0.05 && dv <= -0.05) notes.push('built-up or bare surface rose while vegetation fell, the usual sign of new construction, clearing or earthworks');
  else if (db >= 0.05) notes.push('built-up or bare surface rose');
  else if (dv <= -0.08) notes.push('vegetation fell (could be harvest, season, drought or clearing)');
  else if (dv >= 0.08) notes.push('vegetation rose (could be season, regrowth or irrigation)');
  if (Math.abs(dw) >= 0.05) notes.push(`open-water signal ${dw > 0 ? 'rose' : 'fell'}`);
  const significant = notes.length > 0;
  return { ndvi_change: dv, ndbi_change: db, ndwi_change: dw, significant, text: significant ? notes.join('; ') : 'no significant change at 10 m scale (every index moved by less than 0.05)' };
}

// Latest (or first on or after `after`) clear scene, plus a baseline scene:
// the one nearest `compareTo` if given, else the clearest one about a year
// earlier (same season, so the season does not fake a change).
export async function sceneReport(lat, lon, { km = 2, after = null, compareTo = null, wantCompare = true } = {}) {
  const latestList = after
    ? await searchScenes(lat, lon, { start: after, end: new Date(new Date(after).getTime() + 120 * 86400e3), ascending: true, limit: 4 })
    : await searchScenes(lat, lon, { limit: 4 });
  const latest = latestList[0];
  if (!latest) return null;
  const tLatest = Date.parse(latest.datetime);
  let base = null;
  if (wantCompare) {
    const day = 86400e3;
    const asked = compareTo == null ? null : typeof compareTo === 'number' ? compareTo : Date.parse(compareTo);
    const target = Number.isFinite(asked) ? asked : tLatest - 365 * day;
    // Window is at most a third of the gap, so it never reaches the latest scene.
    const half = Math.max(4 * day, Math.min(30 * day, Math.abs(tLatest - target) / 3));
    const list = await searchScenes(lat, lon, { start: target - half, end: target + half, limit: 20 }).catch(() => []);
    const usable = list.filter((s) => s.id !== latest.id && Math.abs(Date.parse(s.datetime) - tLatest) > 3 * day);
    const sameTile = usable.filter((s) => s.tile && s.tile === latest.tile);
    const pool = sameTile.length ? sameTile : usable;
    base = pool.sort((a, b) => Math.abs(Date.parse(a.datetime) - target) - Math.abs(Date.parse(b.datetime) - target) + (a.cloud_cover - b.cloud_cover) * day / 10)[0] ?? null;
  }
  const [iNow, iBase] = await Promise.all([
    sceneIndexes(latest.id, lat, lon, km),
    base ? sceneIndexes(base.id, lat, lon, km).catch(() => null) : null,
  ]);
  return { box_km: km, latest: { ...latest, indexes: iNow }, baseline: base ? { ...base, indexes: iBase } : null, change: iBase ? describeChange(iNow, iBase) : null };
}
