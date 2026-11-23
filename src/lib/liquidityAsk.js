// Reads a pool or pair named in a liquidity question and measures it from
// DexScreener. The old reader searched on the first three words of the
// question ("Verify total liquidity"), so a named pool such as "Balancer
// rETH/WETH on Ethereum" was answered with an unrelated pool on another
// chain. This one pulls out the two token symbols, the chain and the venue,
// keeps only pools that match all three, and adds up their liquidity. It
// also prices a swap through the pool when the question asks for slippage.

const CHAIN_WORDS = {
  ethereum: 'ethereum', mainnet: 'ethereum', base: 'base', arbitrum: 'arbitrum',
  optimism: 'optimism', polygon: 'polygon', solana: 'solana', bsc: 'bsc', bnb: 'bsc', avalanche: 'avalanche',
};
const CHAIN_ID_WORDS = { eth: 'ethereum', ethereum: 'ethereum', base: 'base', arb: 'arbitrum', arbitrum: 'arbitrum', op: 'optimism', optimism: 'optimism', polygon: 'polygon', sol: 'solana', bsc: 'bsc', avax: 'avalanche' };
const DEX_WORDS = ['uniswap', 'sushiswap', 'sushi', 'curve', 'balancer', 'aerodrome', 'velodrome', 'pancakeswap', 'raydium', 'orca', 'camelot', 'trader joe', 'maverick', 'kyber'];
const SKIP = new Set(['verify', 'total', 'liquidity', 'depth', 'pool', 'pair', 'what', 'the', 'for', 'and', 'on', 'in', 'of', 'a', 'v2', 'v3', 'dex', 'volume', 'how', 'much', 'push', 'through', 'get', 'do', 'i', 'is', 'slippage', 'that', 'at', 'block', 'if']);

const same = (a, b) => {
  const n = (s) => String(s ?? '').toUpperCase().replace(/^W(ETH|BTC)$/, '$1').replace(/\.E$/, '');
  return n(a) === n(b);
};

export function parseLiquidityAsk(text) {
  const t = String(text ?? '').trim();
  // Pool id form: "ETH-WETH-USDC-005" (chain, token, token, fee tier).
  const id = /^(?:LIQUIDITY_DEPTH_VERIFY\w*\s+)?([A-Za-z]{2,12})-([A-Za-z0-9.]{2,12})-([A-Za-z0-9.]{2,12})-(\d{2,5})$/.exec(t);
  if (id) return { a: id[2], b: id[3], chain: CHAIN_ID_WORDS[id[1].toLowerCase()] ?? null, dex: null, fee: id[4], swap: null };
  let a = null;
  let b = null;
  const pair = /\b([A-Za-z][A-Za-z0-9.]{1,11})\s*\/\s*([A-Za-z][A-Za-z0-9.]{1,11})\b/.exec(t);
  if (pair) { a = pair[1]; b = pair[2]; }
  const lower = t.toLowerCase();
  let chain = null;
  for (const [w, c] of Object.entries(CHAIN_WORDS)) {
    if (new RegExp(`\\b${w}\\b`).test(lower)) { chain = c; break; }
  }
  const dex = DEX_WORDS.find((d) => lower.includes(d)) ?? null;
  // "push 0.873 AAVE through the AAVE/WETH ... pair"
  const sw = /(?:push|swap|sell|trade|send|put)\s+([\d,.]+)\s+([A-Za-z][A-Za-z0-9.]{1,11})/i.exec(t);
  const swap = sw ? { amount: Number(sw[1].replace(/,/g, '')), symbol: sw[2] } : null;
  if (!a) {
    const word = t.replace(/[^A-Za-z0-9. ]/g, ' ').split(/\s+/).find((w) => /^[A-Za-z][A-Za-z0-9.]{1,9}$/.test(w) && !SKIP.has(w.toLowerCase()) && !CHAIN_WORDS[w.toLowerCase()] && !DEX_WORDS.includes(w.toLowerCase()) && (/[A-Z]{2,}/.test(w) || /\d/.test(w)));
    if (word) a = word;
  }
  const version = /\bv([234])\b/i.exec(t)?.[1] ?? null;
  return { a, b, chain, dex, fee: null, swap, version };
}

async function search(q) {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(9_000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`DexScreener returned HTTP ${res.status}`);
  return (await res.json()).pairs ?? [];
}

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

export async function liquidityFor(text) {
  const ask = parseLiquidityAsk(text);
  if (!ask.a) return null;
  const queries = ask.b ? [`${ask.a} ${ask.b}`, `${ask.a}/${ask.b}`] : [ask.a];
  let pools = [];
  for (const q of queries) {
    pools = (await search(q).catch(() => [])).filter((p) => p.liquidity?.usd);
    if (pools.length) break;
  }
  const matchPair = (p) => (ask.b
    ? (same(p.baseToken.symbol, ask.a) && same(p.quoteToken.symbol, ask.b)) || (same(p.baseToken.symbol, ask.b) && same(p.quoteToken.symbol, ask.a))
    : same(p.baseToken.symbol, ask.a) || same(p.quoteToken.symbol, ask.a));
  let list = pools.filter(matchPair);
  const notes = [];
  if (ask.chain) {
    const onChain = list.filter((p) => p.chainId === ask.chain);
    if (onChain.length) list = onChain; else if (list.length) notes.push(`no matching pool was listed on ${ask.chain}, so pools on other chains are shown`);
  }
  if (ask.dex) {
    const key = ask.dex.replace(/\s+/g, '');
    const onDex = list.filter((p) => String(p.dexId).toLowerCase().includes(key));
    if (onDex.length) list = onDex; else if (list.length) notes.push(`DexScreener lists no ${ask.dex} pool for this pair, so pools on other venues are shown`);
  }
  if (ask.version) {
    const v = list.filter((p) => (p.labels ?? []).some((l) => String(l).toLowerCase() === `v${ask.version}`));
    if (v.length) list = v; else if (list.length) notes.push(`DexScreener does not label a v${ask.version} pool for this pair, so pools of any version are shown`);
  }
  if (ask.fee) {
    const tier = ask.fee.replace(/^0+/, '');
    const f = list.filter((p) => (p.labels ?? []).some((l) => String(l).includes(tier)));
    if (f.length) list = f;
  }
  list.sort((x, y) => y.liquidity.usd - x.liquidity.usd);
  if (!list.length) {
    const what = ask.b ? `${ask.a}/${ask.b}` : ask.a;
    const why = `No DEX pool for ${what}${ask.chain ? ` on ${ask.chain}` : ''}${ask.dex ? ` at ${ask.dex}` : ''} with listed liquidity was found on DexScreener, so no liquidity depth is stated. Send the pool contract address or the exact pair and the figures are read directly.`;
    return { found: false, answer: why, reason: why };
  }
  const top = list.slice(0, 5);
  const total = list.reduce((s, p) => s + p.liquidity.usd, 0);
  const t = top[0];
  const depth = total > 5_000_000 ? 'Deep' : total > 500_000 ? 'Adequate' : total > 50_000 ? 'Thin' : 'Very thin';
  let answer = `${depth} liquidity. ${t.baseToken.symbol}/${t.quoteToken.symbol} on ${t.dexId} (${t.chainId}) holds ${money(t.liquidity.usd)} with 24h volume ${money(t.volume?.h24 ?? 0)}; ${list.length === 1 ? 'it is the one matching pool' : `the ${list.length} matching pools together hold ${money(total)}`}.`;
  const extra = {};
  if (ask.swap && t.liquidity.base && t.liquidity.quote) {
    const sellBase = same(ask.swap.symbol, t.baseToken.symbol);
    const sellQuote = same(ask.swap.symbol, t.quoteToken.symbol);
    if (sellBase || sellQuote) {
      const rIn = sellBase ? t.liquidity.base : t.liquidity.quote;
      const rOut = sellBase ? t.liquidity.quote : t.liquidity.base;
      const price = Number(t.priceNative); // quote tokens per one base token
      const spot = sellBase ? price : 1 / price;
      const outSym = sellBase ? t.quoteToken.symbol : t.baseToken.symbol;
      // Reserves that do not balance against the quoted price are not trusted
      // for the price-impact figure; the spot quote is still given.
      const balanced = Number.isFinite(spot) && spot > 0 && rIn > 0 && rOut / (rIn * spot) > 0.5 && rOut / (rIn * spot) < 2;
      const impact = balanced ? ask.swap.amount / (rIn + ask.swap.amount) : null;
      const out = Number.isFinite(spot) && spot > 0 ? ask.swap.amount * spot * (1 - 0.003) * (1 - (impact ?? 0)) : null;
      const slip = impact === null ? null : impact * 100;
      if (out !== null) {
        answer += ` Swapping ${ask.swap.amount} ${ask.swap.symbol} through the largest matching pool returns about ${out.toPrecision(5)} ${outSym} at the current pool price after the 0.3% fee${slip === null ? ' (the pool reserves were not usable for a price-impact figure)' : `, with a price impact of about ${slip.toFixed(4)}% from the pool reserves (constant-product formula)`}. This uses current pool data; reserves at a past block are not read.`;
        Object.assign(extra, { swap_output: out, swap_output_symbol: outSym, slippage_percent: slip === null ? null : Number(slip.toFixed(4)) });
      }
    }
  }
  if (notes.length) answer += ` Note: ${notes.join('; ')}.`;
  answer += ' Source: DexScreener.';
  return {
    found: true, answer, depth, top_pool_liquidity_usd: t.liquidity.usd, total_liquidity_usd: total, ...extra,
    pools: top.map((x) => ({ dex: x.dexId, chain: x.chainId, pair: `${x.baseToken.symbol}/${x.quoteToken.symbol}`, liquidity_usd: x.liquidity.usd, volume_24h: x.volume?.h24 ?? 0, address: x.pairAddress })),
  };
}
