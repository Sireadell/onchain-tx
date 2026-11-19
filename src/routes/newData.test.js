import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pastDateFromText, socialTerms } from './newData.js';

test('air quality: a past day in the question is read as that date', () => {
  const today = new Date('2026-11-12T00:00:00Z');
  assert.equal(pastDateFromText('average PM2.5 in Los Angeles on October 26, 2023?', today), '2023-10-26');
  assert.equal(pastDateFromText('yesterday, July 25th, 2024', today), '2024-07-25');
  assert.equal(pastDateFromText('current AQI in Paris', today), null);
});

test('twitter search: filler words are dropped from the search terms', () => {
  assert.equal(socialTerms('latest tweets about the upcoming solar eclipse on April 8, 2024'), 'solar eclipse April 8 2024');
  // Real scorer questions that used to search "What are discussions ..."
  assert.equal(socialTerms('What are the latest discussions on X about the upcoming SpaceX Starship launch?'), 'SpaceX Starship launch');
  assert.equal(socialTerms('What are people tweeting about the upcoming Super Bowl LVIII on X?'), 'Super Bowl LVIII');
  assert.equal(socialTerms('What are the latest reactions on X/Twitter regarding the upcoming SpaceX Starship test flight?'), 'SpaceX Starship test flight');
  assert.equal(socialTerms('What are the latest discussions about the upcoming Apple event on X?'), 'Apple event');
  assert.equal(socialTerms('#bitcoin'), '#bitcoin');
});

test('twitter search: only posts naming the subject are kept, closest first', async () => {
  const { socialSubject, onTopic, socialRelevance } = await import('./newData.js');
  const s = socialSubject('What are the latest discussions on X about the upcoming SpaceX Starship launch?');
  assert.deepEqual(s.named, ['SpaceX', 'Starship']);
  assert.equal(onTopic('SpaceX caught a Starship upper stage in the tower', s), true);
  assert.equal(onTopic('I encourage people to post more about what the people who are paying Hakeem Jeffries do', s), false);
  const apple = socialSubject('What are the latest discussions about the upcoming Apple event on X?');
  assert.ok(socialRelevance('Apple event was everything', apple) > socialRelevance('Apple Music is great', apple));
  assert.equal(onTopic('Pineapple pizza', apple), false);
  const eclipse = socialSubject('What are people tweeting about the upcoming solar eclipse on April 8, 2024?');
  assert.deepEqual(eclipse.core, ['solar', 'eclipse']);
});

test('air quality context compares readings with the WHO 24-hour guidelines', async () => {
  const { whoContext } = await import('./newData.js');
  const text = whoContext(30, 20, 25);
  assert.match(text, /PM2\.5 at 30 ug\/m3 is 2\.0 times the WHO 24-hour guideline of 15 ug\/m3/);
  assert.match(text, /PM10 at 20 ug\/m3 is within the WHO 24-hour guideline of 45 ug\/m3/);
  assert.match(text, /NO2 at 25 ug\/m3 is within/);
  assert.equal(whoContext(null, undefined, 0), '');
});

async function callReserve(question) {
  const { reserveRouter } = await import('./newData.js');
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/', originalUrl: '/', query: { question }, headers: {} };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json: (b) => resolve(b), setHeader() {}, getHeader() {} };
    reserveRouter(req, res, (e) => reject(e || new Error('not handled')));
  });
}

test('asset reserve: Tether questions lead with the reserve verdict and ratio, peg as a field', async (t) => {
  const report = { data: { usdt: { id: 1795044600, total_assets: '180713002660', total_liabilities: '175246054068', totaltokens_eth: '84296691994', reserve_balance_eth: '4498804504', quarantined_eth: '0' } } };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('tether.to')) return new Response(JSON.stringify(report));
    if (u.includes('stablecoins.llama.fi')) return new Response(JSON.stringify({ peggedAssets: [{ symbol: 'USDT', price: 0.9989 }] }));
    throw new Error('offline');
  });
  const b = await callReserve('Does Tether\'s latest attestation confirm that its reserves fully back the circulating supply of USDT?');
  assert.match(b.summary, /^Yes\. Tether's latest published reserve report/);
  assert.equal(b.collateral_ratio_pct, 103.12);
  assert.equal(b.answer, 'Yes, fully backed: reserve ratio 103.12%');
  assert.equal(b.price_usd, 0.9989);
  assert.equal(b.canonical, undefined);
});

test('asset reserve: an asset with no reserve source says unverified and gives supply', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ peggedAssets: [{ name: 'Dai', symbol: 'DAI', price: 1.0001, circulating: { peggedUSD: 5e9 }, chainCirculating: { Ethereum: { current: { peggedUSD: 5e9 } } } }] })));
  const b = await callReserve('Is DAI fully backed by reserves?');
  assert.match(b.summary, /^Unverified: no attested reserve figure for Dai \(DAI\)/);
  assert.equal(b.verdict, 'unverified');
  assert.equal(b.peg_status, 'On peg');
});
