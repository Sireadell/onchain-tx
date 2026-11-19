import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reserveAssetFrom, asksEthereum, askedReportDate, units, backingVerdict,
  parseTether, tetherAnswer, porAnswer, parseCirclePage, parseCircleApi, circleAnswer, ustcAnswer, POR_FEEDS,
} from './assetReserve.js';

test('reserve asset is read from real scorer questions', () => {
  assert.equal(reserveAssetFrom('As of the latest report, are the reserves backing Tether (USDT) sufficient to cover its circulating supply on Ethereum?'), 'USDT');
  assert.equal(reserveAssetFrom('Do the attested reserves behind USDC cover its circulating supply as of the latest proof-of-reserves report?'), 'USDC');
  assert.equal(reserveAssetFrom('What is the attested reserve for WBTC at its pinned block? WBTC'), 'WBTC');
  assert.equal(reserveAssetFrom('Do the attested reserves behind USTC (TerraClassicUSD) cover its circulating supply?'), 'USTC');
  assert.equal(reserveAssetFrom('stETH proof of reserve'), 'stETH');
  assert.equal(reserveAssetFrom('DAI'), null);
});

test('Ethereum scope and a named past report date are noticed', () => {
  assert.equal(asksEthereum('circulating supply on the Ethereum mainnet'), true);
  assert.equal(asksEthereum('fully back its circulating supply'), false);
  const today = new Date('2026-11-19T00:00:00Z');
  assert.equal(askedReportDate('the proof-of-reserves report dated 2023-10-26', today), '2023-10-26');
  assert.equal(askedReportDate('as of the latest report', today), null);
});

test('fixed-point amounts and the backing verdict', () => {
  assert.equal(units(123456789n, 8), '1.23456789');
  assert.equal(units(100000000n, 8), '1');
  assert.equal(backingVerdict(103.1), 'fully_backed');
  assert.equal(backingVerdict(99.9), 'under_backed');
  assert.equal(backingVerdict(null), 'unverified');
  for (const f of Object.values(POR_FEEDS)) {
    assert.match(f.feed, /^0x[0-9a-fA-F]{40}$/);
    assert.match(f.token, /^0x[0-9a-fA-F]{40}$/);
  }
});

const tetherReport = { data: { usdt: {
  id: 1795044600, total_assets: '180713002660.45', total_liabilities: '175246054068.60',
  totaltokens_eth: '84296691994.49', reserve_balance_eth: '4498804504.78', quarantined_eth: '0',
  totaltokens_tron: '90000000000', reserve_balance_tron: '0', quarantined_tron: '0',
} } };

test('Tether report: yes or no first, ratio, Ethereum split, measured vs attested', () => {
  const t = parseTether(tetherReport);
  assert.equal(t.ratio, 103.12);
  assert.equal(t.chains, 2);
  const b = tetherAnswer(t, { onchain: { supply: 84296691994.49, block: 26450312 }, ethereumAsked: true, pastDate: '2023-10-26' });
  assert.match(b.summary, /^Yes\. Tether's latest published reserve report \(as of 2026-11-18 23:30 UTC\) shows total assets of \$180\.71 billion/);
  assert.match(b.summary, /reserve ratio of 103\.12%/);
  assert.match(b.summary, /On Ethereum, \$79\.80 billion of USDT is in circulation/);
  assert.equal(b.answer, 'Yes, fully backed: reserve ratio 103.12%');
  assert.equal(Object.keys(b).at(-1), 'status');
  assert.match(b.summary, /matching the report/);
  assert.match(b.summary, /Tether's own published figures, not an independent on-chain proof of reserve/);
  assert.match(b.summary, /A report for 2023-10-26 is not read here/);
  assert.equal(b.verdict, 'fully_backed');
  assert.throws(() => parseTether({ data: {} }), /no USDT section/);
});

test('Chainlink Proof of Reserve answer gives the ratio and both figures', () => {
  const base = { sym: 'WBTC', ...POR_FEEDS.WBTC, block: 1, roundId: '7', updatedAt: '2026-11-18T18:55:47.000Z' };
  const yes = porAnswer({ ...base, reserve: '116144.6451', supply: '116132.1837', ratio: 100.01 });
  assert.match(yes.summary, /^Yes\. Chainlink's WBTC Proof of Reserve feed attests 116,144\.6451 BTC/);
  assert.match(yes.summary, /collateral ratio of 100\.01%/);
  const no = porAnswer({ ...base, reserve: '99.95', supply: '100', ratio: 99.95 });
  assert.match(no.summary, /^No\./);
  assert.match(no.summary, /The gap is 0\.05% of supply/);
});

test('Circle page and supply API are parsed', () => {
  const html = '<span id="usdc-in-circulation" data-point="67.97">x</span><script>const usdcReserves = 60.1 + 8.17;</script> As of Nov 16, 2026';
  const c = parseCirclePage(html);
  assert.equal(c.reservesB, 68.27);
  assert.equal(c.asOf, 'Nov 16, 2026');
  assert.throws(() => parseCirclePage('<html></html>'), /layout changed/);
  const api = parseCircleApi({ data: [{ symbol: 'USDC', totalAmount: '68.7e9', chains: [{ chain: 'ETH', amount: '44.7e9', updateDate: '2026-11-19' }] }] });
  assert.equal(api.eth, 44.7e9);
  assert.match(circleAnswer(c, { api }).summary, /^Yes\. Circle's latest reserve report \(as of Nov 16, 2026\) shows \$68\.27 billion/);
});

test('USTC answer says the attested reserve is zero', () => {
  const b = ustcAnswer({ current_price: 0.0043, total_supply: 6071519649, circulating_supply: 5572482319 });
  assert.match(b.summary, /^No\. TerraClassicUSD \(USTC\) has no attested reserves/);
  assert.equal(b.attested_reserve, 0);
});
