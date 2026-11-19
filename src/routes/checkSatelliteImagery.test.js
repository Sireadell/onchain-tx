import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import router, { questionKind, radiusKmOf, yearsOf, placePhrases, landSummary, ndviSummary } from './checkSatelliteImagery.js';
import { classShares, ndviMeaning } from '../lib/modisLand.js';

function startServer(t) {
  const app = express();
  app.use('/satellite-imagery', router);
  const server = app.listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function stubModis(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const str = String(url);
    if (str.startsWith('https://modis.ornl.gov/')) {
      const body = handler(str);
      return new Response(JSON.stringify(body), { status: body ? 200 : 500 });
    }
    return original(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
}

test('satellite: question kinds, radius and years are read from the text', () => {
  assert.equal(questionKind('What is the current NDVI reading for the Yolo Bypass?'), 'ndvi');
  assert.equal(questionKind('What is the current land cover classification for the area around the Hoover Dam?'), 'land');
  assert.equal(questionKind('Show me the latest satellite imagery of the construction site'), null);
  assert.equal(radiusKmOf('within a 5km radius'), 5);
  assert.deepEqual(yearsOf('changes since January 2023'), { since: 2023, until: null });
  assert.deepEqual(yearsOf('between January 1st, 2023, and March 31st, 2023'), { since: 2022, until: 2023 });
  assert.equal(placePhrases('deforestation in the Amazon rainforest near Manaus between January 2023 and March 2023')[0], 'Manaus');
});

test('satellite: land cover shares and the change summary', () => {
  const shares = classShares([16, 16, 7, 17, 255]);
  assert.deepEqual(shares.map((s) => [s.name, s.percent]), [['barren land', 50], ['open shrubland', 25], ['water', 25]]);
  const lc = {
    box_km: 10, latest_year: 2025, compare_year: 2023, latest: shares, earlier: shares,
    urban_percent: 0, water_percent: 25, forest_percent: 0,
    change: { urban_points: 0, water_points: -0.2, forest_points: 0, cropland_points: 0 },
  };
  const s = landSummary({ lat: 36.0157, lon: -114.7375, place: 'Hoover Dam' }, lc, 'based on the most recent Landsat 8 imagery');
  assert.match(s, /^Land cover within about 5 km of Hoover Dam \(36.0157, -114.7375\), from the NASA MODIS 2025 yearly land cover map/);
  assert.match(s, /mostly barren land \(50%\)/);
  assert.match(s, /water -0.2 points/);
  assert.match(s, /No significant change/);
  assert.match(s, /Landsat 8 scenes were not read here/);
});

test('satellite: NDVI summary leads with the number and its meaning', () => {
  assert.match(ndviMeaning(0.7), /dense/);
  const s = ndviSummary({ lat: 38.527, lon: -121.61, place: 'Yolo Bypass Wildlife Area, California' }, {
    mean: 0.437, min: 0.307, max: 0.585, pixels: 81, box_km: 2, period_start: '2026-10-16', period_end: '2026-10-31',
    meaning: ndviMeaning(0.437), year_ago: { period_start: '2025-10-16', mean: 0.374 },
  });
  assert.match(s, /^The current NDVI around Yolo Bypass Wildlife Area, California \(38.527, -121.61\) is 0.44/);
  assert.match(s, /greener by 0.06/);
});

test('satellite: an NDVI question is answered from MODIS end to end', async (t) => {
  stubModis(t, (url) => {
    if (url.includes('MOD13Q1/dates')) return { dates: [{ modis_date: 'A2025289', calendar_date: '2025-10-16' }, { modis_date: 'A2026289', calendar_date: '2026-10-16' }] };
    if (url.includes('MOD13Q1/subset') && url.includes('A2026289')) return { subset: [{ data: [5000, 6000, 7000, -3000] }] };
    if (url.includes('MOD13Q1/subset')) return { subset: [{ data: [5000] }] };
    return null;
  });
  const base = startServer(t);
  const q = 'What is the current NDVI reading at 38.55, -121.6 based on the most recent satellite imagery?';
  const body = await (await fetch(`${base}/satellite-imagery?query=${encodeURIComponent(q)}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.ndvi, 0.6);
  assert.equal(body.pixels, 3);
  assert.equal(body.ndvi_year_ago, 0.5);
  assert.match(body.summary, /is 0.60/);
});
