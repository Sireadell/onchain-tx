// Reserve checks for ASSET_RESERVE_ATTESTATION: what backs a token compared
// with the supply it has to cover, with each figure labelled as measured
// (read on-chain here) or attested (published by the issuer or an oracle).
//
// Sources, all free and keyless:
// - Chainlink Proof of Reserve feeds on Ethereum, read on-chain at one pinned
//   block beside the token's totalSupply() at the same block. Feed and token
//   addresses were checked live on 2026-11-19 (description(), symbol(),
//   decimals()) against Chainlink's public feed directory.
// - Tether's transparency report JSON (app.tether.to/transparency.json).
// - Circle's transparency page (weekly reserve and circulation figures) and
//   Circle's public stablecoin supply API.
// - CoinGecko for USTC supply and price (USTC has no reserves to read).

import { ethCall, getBlockNumber, withRpcBudget } from './ankrRpc.js';

const UA = { 'user-agent': 'txlens-miner/1.0' };

async function fetchOk(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: UA });
  if (!r.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${r.status}`);
  return r;
}

// Chainlink Proof of Reserve feeds on Ethereum. crossChain: the feed attests
// reserves for the token on every chain, so a comparison with the Ethereum
// supply alone overstates coverage.
export const POR_FEEDS = {
  WBTC: { name: 'Wrapped Bitcoin', token: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', tokenDecimals: 8, feed: '0xa81FE04086865e63E12dD3776978E49DEEa2ea4e', feedDecimals: 8, unit: 'BTC', crossChain: false, aliases: ['wbtc', 'wrapped bitcoin'] },
  cbBTC: { name: 'Coinbase Wrapped BTC', token: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', tokenDecimals: 8, feed: '0xcBe87Dc0Cf9d807848a3E703B01A90B28eCFb2a7', feedDecimals: 8, unit: 'BTC', crossChain: true, aliases: ['cbbtc', 'coinbase wrapped btc', 'coinbase wrapped bitcoin'] },
  stETH: { name: 'Lido Staked ETH', token: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', tokenDecimals: 18, feed: '0xAd410E655C0fE4741F573152592eeb766e686CE7', feedDecimals: 18, unit: 'ETH', crossChain: false, aliases: ['steth', 'lido staked eth', 'lido staked ether'] },
  TUSD: { name: 'TrueUSD', token: '0x0000000000085d4780B73119b644AE5ecd22b376', tokenDecimals: 18, feed: '0xBE456fd14720C3aCCc30A2013Bffd782c9Cb75D5', feedDecimals: 18, unit: 'USD', crossChain: true, aliases: ['tusd', 'trueusd', 'true usd'] },
  LBTC: { name: 'Lombard Staked BTC', token: '0x8236a87084f8B84306f72007F36F2618A5634494', tokenDecimals: 8, feed: '0x70c158c7731Da2C14BC84aEBa39A4FF703DDc7d2', feedDecimals: 8, unit: 'BTC', crossChain: true, aliases: ['lbtc', 'lombard'] },
  eETH: { name: 'ether.fi Staked ETH', token: '0x35fA164735182de50811E8e2E824cFb9B6118ac2', tokenDecimals: 18, feed: '0xC8cd82067eA907EA4af81b625d2bB653E21b5156', feedDecimals: 18, unit: 'ETH', crossChain: false, aliases: ['eeth', 'ether.fi', 'etherfi'] },
  FBTC: { name: 'Ignition FBTC', token: '0xC96dE26018A54D51c097160568752c4E3BD6C364', tokenDecimals: 8, feed: '0x75A0d3264a949C2C920d7F25Df174af1FaF73399', feedDecimals: 8, unit: 'BTC', crossChain: true, aliases: ['fbtc'] },
  SolvBTC: { name: 'Solv BTC', token: '0x7A56E1C57C7475CCf742a1832B028F0456652F97', tokenDecimals: 18, feed: '0xda9258AFc797Cd64d1b6FC651051224cdAB1B25E', feedDecimals: 18, unit: 'BTC', crossChain: true, aliases: ['solvbtc', 'solv btc'] },
  uniBTC: { name: 'Bedrock uniBTC', token: '0x004E9C3EF86bc1ca1f0bB5C7662861Ee93350568', tokenDecimals: 8, feed: '0xc590D9fb8eE78a0909dFF341ccf717000b7b7fF2', feedDecimals: 18, unit: 'BTC', crossChain: true, aliases: ['unibtc'] },
};

const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// Which reserve path a question is about. Returns a key of POR_FEEDS, or
// 'USDT', 'USDC', 'USTC', or null for anything else.
export function reserveAssetFrom(text) {
  const t = String(text || '').toLowerCase();
  const words = new Set(t.split(/[^a-z0-9.]+/).map((w) => w.replace(/^\.+|\.+$/g, '')));
  if (words.has('ustc') || /terra\s*classic\s*usd|terraclassicusd/.test(t)) return 'USTC';
  for (const [sym, f] of Object.entries(POR_FEEDS)) {
    if (f.aliases.some((a) => (a.includes(' ') || a.includes('.') ? t.includes(a) : words.has(a)))) return sym;
  }
  if (words.has('usdt') || /\btether\b/.test(t)) return 'USDT';
  if (words.has('usdc') || /\busd coin\b|\bcircle\b/.test(t)) return 'USDC';
  return null;
}

export const asksEthereum = (text) => /\bethereum\b|\beth\s+mainnet\b|\berc-?20\b|\bmainnet\b/i.test(String(text || ''));

// A past date named in the question ("report dated 2023-10-26", "in 2023"),
// so the answer can say plainly that the latest report is what was read.
export function askedReportDate(text, today = new Date()) {
  const t = String(text || '');
  const iso = t.match(/\b(20\d\d-\d\d-\d\d)\b/);
  if (iso) return iso[1];
  const month = t.match(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+20\d\d)\b/i);
  if (month) return month[1];
  const year = t.match(/\b(20\d\d)\b/);
  if (year && Number(year[1]) < today.getUTCFullYear()) return year[1];
  return null;
}

const hexWord = (hex, i) => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));

// Fixed-point BigInt to a decimal string without float rounding.
export function units(raw, decimals) {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

export function fmtAmount(n, maxFrac = 4) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

export function fmtBillions(n) {
  return `$${(Number(n) / 1e9).toFixed(2)} billion`;
}

export function backingVerdict(ratioPct) {
  if (ratioPct == null || !Number.isFinite(ratioPct)) return 'unverified';
  return ratioPct >= 100 ? 'fully_backed' : 'under_backed';
}

/* ---------- Chainlink Proof of Reserve, read on-chain ---------- */
export async function readPorFeed(sym) {
  const f = POR_FEEDS[sym];
  return withRpcBudget(async () => {
    const block = BigInt(await getBlockNumber('eth'));
    const [round, supplyHex, feedDecHex] = await Promise.all([
      ethCall('eth', f.feed, '0xfeaf968c', block), // latestRoundData()
      ethCall('eth', f.token, '0x18160ddd', block), // totalSupply()
      ethCall('eth', f.feed, '0x313ce567', block), // decimals() of the feed
    ]);
    const roundId = hexWord(round, 0);
    const answer = hexWord(round, 1);
    const updatedAt = Number(hexWord(round, 3));
    // Feed decimals are read on-chain; the pinned value is only a fallback.
    const feedDecRead = feedDecHex && feedDecHex.length > 2 ? Number(BigInt(feedDecHex)) : NaN;
    const feedDecimals = Number.isInteger(feedDecRead) && feedDecRead >= 0 && feedDecRead <= 36 ? feedDecRead : f.feedDecimals;
    const reserve = units(answer, feedDecimals);
    const supply = units(BigInt(supplyHex), f.tokenDecimals);
    const ratio = Number(supply) > 0 ? Math.round((Number(reserve) / Number(supply)) * 10000) / 100 : null;
    return { sym, ...f, feedDecimals, block: Number(block), roundId: roundId.toString(), updatedAt: new Date(updatedAt * 1000).toISOString(), reserve, supply, ratio };
  });
}

export function porAnswer(r, { ethereumAsked = false, pastDate = null } = {}) {
  const verdict = backingVerdict(r.ratio);
  const yes = verdict === 'fully_backed';
  const gap = Number(r.reserve) - Number(r.supply);
  const lead = `${yes ? 'Yes' : 'No'}. Chainlink's ${r.sym} Proof of Reserve feed attests ${fmtAmount(r.reserve)} ${r.unit} of reserves (round updated ${r.updatedAt}), against a ${r.sym} total supply of ${fmtAmount(r.supply)} on Ethereum, both read at Ethereum block ${r.block.toLocaleString('en-US')}: a collateral ratio of ${r.ratio}%, ${gap >= 0 ? `${fmtAmount(gap)} ${r.unit} more reserves than supply` : `${fmtAmount(-gap)} ${r.unit} short of the supply`}.`;
  const scope = r.crossChain
    ? ` The feed counts reserves for ${r.sym} on every chain, while the supply here is the Ethereum contract only, so this ratio is an upper bound on coverage${ethereumAsked ? ' for the Ethereum question asked' : ''}.`
    : '';
  const how = ` Measured vs attested: the total supply is measured directly from the token contract (${r.token}); the reserve figure is attested by the Chainlink feed (${r.feed}, round ${r.roundId}) and is not something an on-chain read can audit.`;
  const near = !yes && r.ratio != null && r.ratio >= 99 ? ` The gap is ${(100 - r.ratio).toFixed(2)}% of supply, small enough that it can come from supply moving since the feed's last update.` : '';
  const dated = pastDate ? ` A report for ${pastDate} is not stored on-chain; the figures above are the latest feed round.` : '';
  const summary = lead + near + scope + how + dated;
  return {
    answer: `${fmtAmount(r.reserve)} ${r.unit} attested in reserve for ${r.sym} at Ethereum block ${r.block}, collateral ratio ${r.ratio}% (${yes ? 'fully backed' : 'not fully backed'})`,
    asset: r.sym, attested_reserve: r.reserve, total_supply: r.supply, unit: r.unit, collateral_ratio_pct: r.ratio,
    block: r.block, round_id: r.roundId, as_of: r.updatedAt,
    source: `Chainlink ${r.sym} Proof of Reserve (${r.feed}) and the ${r.sym} token contract on Ethereum`,
    verdict, found: true, confidence: 0.9,
    summary,
    status: 'ok',
  };
}

/* ---------- Tether (USDT) ---------- */
export function parseTether(j) {
  const u = j?.data?.usdt;
  if (!u) throw new Error('Tether report had no USDT section');
  const num = (v) => Number(v) || 0;
  const assets = num(u.total_assets);
  const liabilities = num(u.total_liabilities);
  const ethIssued = num(u.totaltokens_eth);
  const ethTreasury = num(u.reserve_balance_eth);
  const ethQuarantined = num(u.quarantined_eth);
  let circulating = 0;
  let chains = 0;
  for (const k of Object.keys(u)) {
    const m = k.match(/^totaltokens_(.+)$/);
    if (!m) continue;
    const c = num(u[k]) - num(u[`reserve_balance_${m[1]}`]) - num(u[`quarantined_${m[1]}`]);
    if (c > 0) { circulating += c; chains += 1; }
  }
  const asOf = Number.isFinite(Number(u.id)) && Number(u.id) > 1e9 ? new Date(Number(u.id) * 1000).toISOString() : null;
  return { assets, liabilities, equity: assets - liabilities, ratio: liabilities ? Math.round((assets / liabilities) * 10000) / 100 : null, circulating, chains, ethIssued, ethTreasury, ethCirculating: ethIssued - ethTreasury - ethQuarantined, asOf };
}

async function ethSupply(token, decimals) {
  return withRpcBudget(async () => {
    const block = BigInt(await getBlockNumber('eth'));
    const hex = await ethCall('eth', token, '0x18160ddd', block);
    return { supply: Number(units(BigInt(hex), decimals)), block: Number(block) };
  });
}

export function tetherAnswer(t, { onchain = null, peg = null, ethereumAsked = false, pastDate = null } = {}) {
  const verdict = backingVerdict(t.ratio);
  const yes = verdict === 'fully_backed';
  const when = t.asOf ? t.asOf.replace('T', ' ').replace(/:00.000Z$/, ' UTC') : 'its latest update';
  let s = `${yes ? 'Yes' : 'No'}. Tether's latest published reserve report (as of ${when}) shows total assets of ${fmtBillions(t.assets)} against total liabilities of ${fmtBillions(t.liabilities)} (${fmtBillions(t.circulating)} of USDT in circulation across ${t.chains} chains), so reserves ${yes ? 'exceed' : 'fall short of'} the circulating supply, at a reserve ratio of ${t.ratio}% (${yes ? 'excess' : 'shortfall'} of ${fmtBillions(Math.abs(t.equity))}).`;
  if (ethereumAsked || onchain) {
    s += ` On Ethereum, ${fmtBillions(t.ethCirculating)} of USDT is in circulation; the reserves back USDT on every chain together, not per chain.`;
  }
  if (onchain) {
    const diff = Math.abs(onchain.supply - t.ethIssued) / Math.max(1, t.ethIssued);
    s += ` The USDT contract's totalSupply on Ethereum, read at block ${onchain.block.toLocaleString('en-US')}, is ${fmtAmount(onchain.supply, 2)} USDT (including ${fmtBillions(t.ethTreasury)} unissued in Tether's treasury)${diff < 0.005 ? ', matching the report' : ', which differs from the report because issuance has moved since it was published'}.`;
  }
  s += " These are Tether's own published figures, not an independent on-chain proof of reserve; USDT has no Chainlink proof-of-reserve feed.";
  if (pastDate) s += ` A report for ${pastDate} is not read here; the figures above are the latest published ones.`;
  const label = `${yes ? 'Yes, fully backed' : 'No, not fully backed'}: reserve ratio ${t.ratio}%`;
  return {
    answer: label,
    asset: 'USDT', attested_reserve: t.assets, total_supply: t.circulating, collateral_ratio_pct: t.ratio, as_of: t.asOf,
    price_usd: peg?.price ?? null,
    source: 'Tether transparency report (https://app.tether.to/transparency.json)' + (onchain ? ' and the USDT contract on Ethereum' : ''),
    verdict, found: true, confidence: 0.85,
    summary: s,
    status: 'ok',
  };
}

/* ---------- Circle (USDC) ---------- */
export function parseCirclePage(html) {
  const tag = String(html).match(/<span[^>]*id="usdc-in-circulation"[^>]*>/);
  const circ = tag && tag[0].match(/data-point="([0-9.]+)"/);
  const sum = String(html).match(/const\s+usdcReserves\s*=\s*([0-9.+\s]+);/);
  const asOf = String(html).match(/As of ([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})/);
  if (!circ || !sum) throw new Error('Circle transparency page layout changed');
  const reserves = sum[1].split('+').map((x) => Number(x.trim())).reduce((a, b) => a + b, 0);
  const circulating = Number(circ[1]);
  return { reservesB: Math.round(reserves * 100) / 100, circulatingB: circulating, ratio: Math.round((reserves / circulating) * 10000) / 100, asOf: asOf ? asOf[1] : null };
}

export function parseCircleApi(j) {
  const u = (j?.data || []).find((c) => c.symbol === 'USDC');
  if (!u) return null;
  const eth = (u.chains || []).find((c) => c.chain === 'ETH');
  const updated = (u.chains || []).map((c) => c.updateDate).filter(Boolean).sort().pop() || null;
  return { total: Number(u.totalAmount), eth: eth ? Number(eth.amount) : null, updated };
}

export function circleAnswer(c, { api = null, onchain = null, peg = null, ethereumAsked = false, pastDate = null } = {}) {
  const verdict = backingVerdict(c.ratio);
  const yes = verdict === 'fully_backed';
  let s = `${yes ? 'Yes' : 'No'}. Circle's latest reserve report (as of ${c.asOf || 'its latest weekly update'}) shows $${c.reservesB.toFixed(2)} billion of total reserves against $${c.circulatingB.toFixed(2)} billion of USDC in circulation, a coverage ratio of ${c.ratio}% (${yes ? 'excess' : 'shortfall'} of $${Math.abs(c.reservesB - c.circulatingB).toFixed(2)} billion). The reserves are cash at banks and short-dated US Treasuries and overnight Treasury repo, mostly held in the Circle Reserve Fund managed by BlackRock.`;
  if (api) s += ` Circle's live supply feed now reports ${fmtBillions(api.total)} of USDC across all chains${api.eth != null ? `, ${fmtBillions(api.eth)} of it on Ethereum` : ''}${api.updated ? ` (updated ${api.updated})` : ''}.`;
  if (onchain) s += ` Read on-chain at Ethereum block ${onchain.block.toLocaleString('en-US')}, the USDC contract's totalSupply is ${fmtAmount(onchain.supply, 2)} USDC.`;
  else if (ethereumAsked && api?.eth != null) s += ' The reserves are one pool backing USDC on every chain, so the Ethereum supply is covered as part of the total.';
  s += ` Measured vs attested: the reserve figure is Circle's own published number (checked monthly by an independent accountant's attestation), not readable on-chain; ${onchain ? 'the Ethereum supply is measured directly from the USDC contract' : 'the circulation figure comes from the same report'}. USDC has no Chainlink Proof of Reserve feed.`;
  if (pastDate) s += ` A report for ${pastDate} is not read here; the figures above are the latest published ones.`;
  return {
    answer: `${yes ? 'Yes, fully backed' : 'No, not fully backed'}: coverage ratio ${c.ratio}%`,
    asset: 'USDC', attested_reserve: Math.round(c.reservesB * 1e9), total_supply: Math.round(c.circulatingB * 1e9), collateral_ratio_pct: c.ratio, as_of: c.asOf,
    price_usd: peg?.price ?? null,
    source: 'Circle transparency page (https://www.circle.com/transparency)' + (api ? ' and Circle stablecoin API' : ''),
    verdict, found: true, confidence: 0.8,
    summary: s,
    status: 'ok',
  };
}

/* ---------- USTC ---------- */
export function ustcAnswer(m, { pastDate = null } = {}) {
  const price = m?.current_price;
  const supply = m?.total_supply ?? m?.circulating_supply;
  let s = 'No. TerraClassicUSD (USTC) has no attested reserves and no proof-of-reserves report: it was an algorithmic stablecoin held at 1 USD by minting and burning LUNA, not by cash or Treasuries, and the bitcoin reserve the Luna Foundation Guard held for it was spent defending the peg in the May 2022 collapse. The attested reserve amount is therefore zero, which covers none of its supply.';
  if (supply) s += ` Its total supply is now ${fmtAmount(supply, 0)} USTC${m?.circulating_supply ? ` (${fmtAmount(m.circulating_supply, 0)} circulating)` : ''}${price != null ? `, and it trades at ${price} USD, about ${(100 - price * 100).toFixed(2)}% below its old 1 USD peg` : ''}.`;
  if (pastDate) s += ` That holds for ${pastDate} too: no reserve report has been published since the collapse.`;
  s += ' Measured vs attested: there is nothing attested; supply and price are market data.';
  return {
    answer: 'No: USTC has zero attested reserves, so none of its supply is covered',
    asset: 'USTC', attested_reserve: 0, total_supply: supply ?? null, circulating_supply: m?.circulating_supply ?? null, collateral_ratio_pct: 0,
    price_usd: price ?? null, source: 'CoinGecko (terrausd)',
    verdict: 'under_backed', found: true, confidence: 0.8,
    summary: s,
    status: 'ok',
  };
}

/* ---------- entry point ---------- */
async function getJson(url, ms) {
  return (await fetchOk(url, ms)).json();
}

async function llamaPeg(symbol) {
  try {
    const j = await getJson('https://stablecoins.llama.fi/stablecoins?includePrices=true', 8_000);
    const c = (j.peggedAssets || []).find((x) => x.symbol === symbol);
    return c ? { price: c.price } : null;
  } catch { return null; }
}

const soft = (p) => p.catch(() => null);

// Returns a full response body, or null when the asset has no reserve source
// here (the caller then falls back to the supply-and-peg answer).
export async function reserveCheck(text, { now = new Date() } = {}) {
  const asset = reserveAssetFrom(text);
  if (!asset) return null;
  const ethereumAsked = asksEthereum(text);
  const pastDate = askedReportDate(text, now);
  const checked_at = now.toISOString();
  if (POR_FEEDS[asset]) {
    return { ...porAnswer(await readPorFeed(asset), { ethereumAsked, pastDate }), checked_at };
  }
  if (asset === 'USDT') {
    const [rep, onchain, peg] = await Promise.all([
      getJson('https://app.tether.to/transparency.json', 12_000),
      soft(ethSupply(USDT_ETH, 6)),
      llamaPeg('USDT'),
    ]);
    return { ...tetherAnswer(parseTether(rep), { onchain, peg, ethereumAsked, pastDate }), checked_at };
  }
  if (asset === 'USDC') {
    const [page, api, onchain, peg] = await Promise.all([
      fetchOk('https://www.circle.com/transparency', 12_000).then((r) => r.text()),
      soft(getJson('https://api.circle.com/v1/stablecoins', 8_000).then(parseCircleApi)),
      ethereumAsked ? soft(ethSupply(USDC_ETH, 6)) : Promise.resolve(null),
      llamaPeg('USDC'),
    ]);
    return { ...circleAnswer(parseCirclePage(page), { api, onchain, peg, ethereumAsked, pastDate }), checked_at };
  }
  if (asset === 'USTC') {
    const m = await soft(getJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=terrausd', 8_000).then((a) => a?.[0] ?? null));
    return { ...ustcAnswer(m, { pastDate }), checked_at };
  }
  return null;
}
