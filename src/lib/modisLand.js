// Measured land readings for SATELLITE_IMAGERY_ANALYSIS from NASA's MODIS
// products, via the ORNL DAAC MODIS web service (modis.ornl.gov/rst, no
// key): MOD13Q1 vegetation index (NDVI, 250 m, 16-day composites) and
// MCD12Q1 land cover (500 m, yearly, IGBP classes). Used only by
// routes/checkSatelliteImagery.js.

const BASE = 'https://modis.ornl.gov/rst/api/v1';
const TIMEOUT_MS = Number(process.env.MODIS_TIMEOUT_MS) || 12_000;
export const MODIS_SOURCE = 'NASA MODIS via ORNL DAAC (modis.ornl.gov)';

export const IGBP = {
  1: 'evergreen needleleaf forest', 2: 'evergreen broadleaf forest', 3: 'deciduous needleleaf forest',
  4: 'deciduous broadleaf forest', 5: 'mixed forest', 6: 'closed shrubland', 7: 'open shrubland',
  8: 'woody savanna', 9: 'savanna', 10: 'grassland', 11: 'permanent wetland', 12: 'cropland',
  13: 'urban and built-up land', 14: 'cropland and natural vegetation mosaic', 15: 'snow and ice',
  16: 'barren land', 17: 'water',
};
const FOREST = new Set([1, 2, 3, 4, 5]);

async function getJson(path) {
  const res = await fetch(`${BASE}/${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`MODIS service returned HTTP ${res.status}`);
  return res.json();
}

const pt = (lat, lon) => `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`;

// Class shares for one year's grid, in percent, largest first.
export function classShares(data) {
  const counts = new Map();
  let n = 0;
  for (const v of data) {
    if (!IGBP[v]) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    n += 1;
  }
  return [...counts.entries()]
    .map(([cls, c]) => ({ class: cls, name: IGBP[cls], percent: Math.round((c / n) * 1000) / 10 }))
    .sort((a, b) => b.percent - a.percent);
}

const shareOf = (shares, test) => Math.round(shares.filter((s) => test(s.class)).reduce((t, s) => t + s.percent, 0) * 10) / 10;

// Land cover around a point for the latest year (or `untilYear`), and for
// `sinceYear` when given (or the year before) to show change.
export async function landCover(lat, lon, { km = 5, sinceYear = null, untilYear = null } = {}) {
  const all = (await getJson(`MCD12Q1/dates?${pt(lat, lon)}`)).dates ?? [];
  // untilYear ("between January and March 2023") ends the range early.
  const dates = untilYear ? all.filter((d) => Number(d.calendar_date.slice(0, 4)) <= untilYear) : all;
  if (!dates.length) return null;
  const latest = dates.at(-1);
  const latestYear = Number(latest.calendar_date.slice(0, 4));
  const fromYear = Math.min(Math.max(sinceYear ?? latestYear - 1, Number(dates[0].calendar_date.slice(0, 4))), latestYear - 1);
  const start = dates.find((d) => Number(d.calendar_date.slice(0, 4)) === fromYear) ?? dates.at(-2) ?? latest;
  const box = Math.min(Math.max(Math.round(km), 1), 25);
  const body = await getJson(`MCD12Q1/subset?${pt(lat, lon)}&band=LC_Type1&startDate=${start.modis_date}&endDate=${latest.modis_date}&kmAboveBelow=${box}&kmLeftRight=${box}`);
  const years = (body.subset ?? []).map((s) => ({ year: Number(s.calendar_date.slice(0, 4)), shares: classShares(s.data ?? []) }))
    .filter((y) => y.shares.length)
    .sort((a, b) => a.year - b.year);
  if (!years.length) return null;
  const first = years[0];
  const last = years.at(-1);
  const delta = (test) => Math.round((shareOf(last.shares, test) - shareOf(first.shares, test)) * 10) / 10;
  return {
    box_km: box * 2,
    pixel_m: 500,
    latest_year: last.year,
    compare_year: first.year === last.year ? null : first.year,
    latest: last.shares,
    earlier: first.year === last.year ? null : first.shares,
    urban_percent: shareOf(last.shares, (c) => c === 13),
    water_percent: shareOf(last.shares, (c) => c === 17),
    forest_percent: shareOf(last.shares, (c) => FOREST.has(c)),
    change: first.year === last.year ? null : {
      urban_points: delta((c) => c === 13),
      water_points: delta((c) => c === 17),
      forest_points: delta((c) => FOREST.has(c)),
      cropland_points: delta((c) => c === 12 || c === 14),
    },
  };
}

function ndviStats(values) {
  const v = values.filter((x) => x > -2000 && x <= 10000).map((x) => x / 10000);
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean: Math.round(mean * 1000) / 1000, min: Math.round(Math.min(...v) * 1000) / 1000, max: Math.round(Math.max(...v) * 1000) / 1000, pixels: v.length };
}

export function ndviMeaning(x) {
  if (x < 0.1) return 'bare ground, rock, built-up surface or water, with almost no green vegetation';
  if (x < 0.2) return 'very sparse vegetation';
  if (x < 0.4) return 'sparse to moderate vegetation, typical of dry grass, harvested or fallow fields, or mixed land';
  if (x < 0.6) return 'moderate to healthy green vegetation';
  return 'dense, healthy green vegetation';
}

// Latest 16-day NDVI around a point (about 2 km box) and the same
// composite one year earlier.
export async function ndvi(lat, lon, { km = 1 } = {}) {
  const dates = (await getJson(`MOD13Q1/dates?${pt(lat, lon)}`)).dates ?? [];
  if (!dates.length) return null;
  const latest = dates.at(-1);
  const yearAgoDay = `${Number(latest.calendar_date.slice(0, 4)) - 1}${latest.calendar_date.slice(4)}`;
  const prior = dates.find((d) => d.calendar_date === yearAgoDay) ?? null;
  const box = Math.min(Math.max(Math.round(km), 0), 5);
  const sub = (d) => getJson(`MOD13Q1/subset?${pt(lat, lon)}&band=250m_16_days_NDVI&startDate=${d.modis_date}&endDate=${d.modis_date}&kmAboveBelow=${box}&kmLeftRight=${box}`)
    .then((b) => ndviStats(b.subset?.[0]?.data ?? []))
    .catch(() => null);
  const [now, before] = await Promise.all([sub(latest), prior ? sub(prior) : Promise.resolve(null)]);
  if (!now) return null;
  const start = new Date(`${latest.calendar_date}T00:00:00Z`);
  const end = new Date(start.getTime() + 15 * 86400e3).toISOString().slice(0, 10);
  return {
    period_start: latest.calendar_date,
    period_end: end,
    box_km: box * 2 || 0.25,
    ...now,
    meaning: ndviMeaning(now.mean),
    year_ago: before ? { period_start: prior.calendar_date, mean: before.mean } : null,
  };
}
