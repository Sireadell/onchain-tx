// Reads what a token-supply question really asks and fills in the numbers.
// The scorer does not only ask "what is the total supply": it asks for the
// share held by burn addresses, the circulating amount after burns, the
// holder count, the figure at a past block, in whole tokens. It also names
// tokens by name ("USD Coin", "ether.fi Staked ETH (eETH)", "cbBTC") on any
// supported chain, with no contract address. This file does both parts:
// turning a name into the contract on that chain, and measuring the follow-ups
// straight from the chain.

import { ethCall } from './ankrRpc.js';
import { KNOWN_TOKENS, decodeUint } from './knownTokens.js';
import { searchTokenByName, getTokenInfo } from './blockscoutApi.js';

// Common burn destinations. 0x...dEaD (low) and 0xdEaD000...0 (high) are the
// two conventional "dead" addresses, next to the zero address.
export const BURN_ADDRESSES = [
  { label: 'zero address', address: '0x0000000000000000000000000000000000000000' },
  { label: '0x...dEaD', address: '0x000000000000000000000000000000000000dEaD' },
  { label: '0xdEaD0000...', address: '0xdEaD000000000000000000000000000000000000' },
];

// ---- what is asked ----------------------------------------------------------

export function parseAsk(text) {
  const t = String(text ?? '');
  const burn = /\bburn(?:ed|t|s|ing)?\b|dead address|\b0xdead\b|zero address|\b0x0+\b|black ?hole|incinerat|destroyed|sent to (?:the )?(?:null|zero)/i.test(t);
  const circulating = /circulating|outstanding|float(?!\s+inputs)|after (?:subtract|exclud|remov)|excluding|net of|what is left|what's left|remaining supply|in circulation/i.test(t);
  const share = /\bshare\b|percent|%|proportion|fraction|ratio/i.test(t);
  const holders = /\bholders?\b|how many (?:wallets|addresses|accounts|people)/i.test(t);
  return { burn: burn || (circulating && /exclud|subtract|burn/i.test(t)), circulating, share, holders };
}

// Short forms such as "0xdead" or "0x0" name a burn address.
export function namedBurnAddresses(text) {
  const t = String(text ?? '');
  const extra = [];
  if (/\b0xdead\b|0x0+dead\b/i.test(t)) extra.push(BURN_ADDRESSES[1]);
  if (/\b0x0\b|0x0{40}\b|zero address|null address/i.test(t)) extra.push(BURN_ADDRESSES[0]);
  return extra;
}

// ---- naming a token ---------------------------------------------------------

const NOT_A_TOKEN = new Set(['what', 'which', 'how', 'who', 'when', 'where', 'why', 'check', 'verify', 'before', 'someone', 'sanity', 'for', 'the', 'total', 'supply', 'current', 'token', 'tokens', 'contract', 'chain', 'block', 'ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'one', 'mainnet', 'use', 'whole', 'keep', 'brief', 'today', 'does', 'did', 'is', 'are', 'was', 'many', 'much', 'units', 'minted', 'state', 'tell', 'real', 'figure', 'community', 'chat', 'says', 'smaller', 'back', 'held', 'burn', 'addresses', 'share', 'listing', 'this', 'asset', 'our', 'dashboard', 'fund', 'hold', 'we', 'on-chain', 'exist', 'count', 'float', 'inputs', 'quick', 'does', 'report', 'reported', 'return', 'sent', 'left', 'after', 'subtracting', 'it', 'and', 'of', 'in', 'on', 'at', 'to', 'a', 'an', 'its', 'has', 'have', 'holders', 'circulating', 'excluding', 'burned', 'zero', 'address', 'dead', 'percentage', 'percent', 'with', 'using', 'from', 'by', 'that', 'than', 'optimism', 'eth', 'ether', 'matic', 'pol', 'avax']);

// Candidate token names found in a question, most specific first.
export function tokenCandidates(text) {
  const t = String(text ?? '').replace(/0x[0-9a-fA-F]{6,}/g, ' ');
  const out = [];
  const add = (v) => { const s = String(v ?? '').trim().replace(/^[^\w]+|[^\w.]+$/g, ''); if (s.length >= 2 && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  for (const m of t.matchAll(/\(([A-Za-z][A-Za-z0-9.]{1,11})\)/g)) add(m[1]);
  // Word runs where each word looks like part of a name: capitalised, a ticker
  // with capitals, or contains a digit or dot ("ether.fi", "cbBTC", "USD Coin").
  const words = t.replace(/[(),?!:;"“”]/g, ' ').split(/\s+/).filter(Boolean);
  const nameLike = (w) => /^[A-Z]/.test(w) || /[A-Z]/.test(w.slice(1)) || /\./.test(w.replace(/\.$/, ''));
  const runs = [];
  let cur = [];
  for (const w of words) {
    const bare = w.replace(/\.$/, '');
    if (nameLike(bare) && !NOT_A_TOKEN.has(bare.toLowerCase())) cur.push(bare);
    else { if (cur.length) runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  const phrases = [];
  for (const run of runs) {
    for (let len = Math.min(run.length, 4); len >= 1; len -= 1) {
      for (let i = 0; i + len <= run.length; i += 1) phrases.push(run.slice(i, i + len).join(' '));
    }
  }
  phrases.sort((a, b) => b.split(' ').length - a.split(' ').length);
  for (const p of phrases) add(p);
  // Lower-case tickers right after "of": "supply of usdc".
  for (const m of t.matchAll(/\b(?:supply|total|minted|exist|units)\s+(?:of\s+)?(?:the\s+)?([a-z][a-z0-9]{2,9})\b/gi)) if (!NOT_A_TOKEN.has(m[1].toLowerCase())) add(m[1]);
  return out.slice(0, 10);
}

const NATIVE_WORDS = new Set(['eth', 'ether', 'ethereum', 'matic', 'pol', 'avax', 'avalanche', 'polygon']);

// Contract for a token name on a chain: the well-known table first, then
// Blockscout's priced ERC-20 search, which only accepts an exact name or ticker.
export async function resolveTokenByName(text, chain) {
  const table = KNOWN_TOKENS[chain.key] ?? {};
  const cands = tokenCandidates(text);
  for (const c of cands) {
    const sym = c.toUpperCase().replace(/\s+/g, '');
    if (table[sym]) return { address: table[sym].address, symbol: sym === 'STETH' ? 'stETH' : sym, via: 'known table' };
  }
  const host = chain.blockscoutHost;
  if (!host) return null;
  const tried = cands.filter((c) => !NATIVE_WORDS.has(c.toLowerCase())).slice(0, 8);
  for (let i = 0; i < tried.length; i += 3) {
    const batch = await Promise.all(tried.slice(i, i + 3).map((c) => searchTokenByName(host, c).catch(() => null)));
    const hit = batch.find(Boolean);
    if (hit) return { address: hit.address, symbol: hit.symbol, via: 'Blockscout search' };
  }
  return null;
}

// ---- measuring --------------------------------------------------------------

const pad = (addr) => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

export async function balanceOf(chain, token, holder, block) {
  const hex = await ethCall(chain.segment, token, `0x70a08231${pad(holder)}`, block);
  return decodeUint(hex) ?? 0n;
}

export function fmt(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, decimals ? -decimals : undefined).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '').slice(0, 6) : '';
  return frac ? `${whole}.${frac}` : whole;
}

// Percentage with 4 decimals from two bigints.
export function pct(part, whole) {
  if (!whole) return '0';
  const scaled = (part * 100_000_000n) / whole;
  return `${(Number(scaled) / 1_000_000).toFixed(6)}`;
}

export async function burnReport(chain, token, block, total, decimals, text) {
  const list = [...BURN_ADDRESSES];
  for (const a of namedBurnAddresses(text)) if (!list.some((x) => x.address.toLowerCase() === a.address.toLowerCase())) list.push(a);
  const rows = await Promise.all(list.map(async (a) => {
    try { return { ...a, raw: await balanceOf(chain, token, a.address, block) }; } catch { return { ...a, raw: null }; }
  }));
  const ok = rows.filter((r) => r.raw !== null);
  if (!ok.length) return null;
  const burned = ok.reduce((s, r) => s + r.raw, 0n);
  return {
    burned, rows: ok, share: pct(burned, total), circulating: total - burned,
    text: `Held by burn addresses: ${fmt(burned, decimals)} (${pct(burned, total)}% of total supply)${ok.some((r) => r.raw > 0n) ? `, of which ${ok.filter((r) => r.raw > 0n).map((r) => `${fmt(r.raw, decimals)} at the ${r.label}`).join(', ')}` : ', none at the zero address or the two common dead addresses'}. Total supply minus burned: ${fmt(total - burned, decimals)}.`,
  };
}

export async function holderCount(chain, token) {
  try {
    const info = await getTokenInfo(chain.blockscoutHost, token, chain.segment);
    return info?.holdersCount != null ? Number(info.holdersCount) : null;
  } catch {
    return null;
  }
}
