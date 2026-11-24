// Solana reads for the four on-chain routes (balance, supply, holders, tx).
//
// Entity reading: a Solana address or token mint is 32 bytes written in base58
// (32 to 44 characters), and a transaction signature is 64 bytes in base58
// (usually 87 or 88 characters). A string is only accepted when it decodes to
// exactly that many bytes, so an ordinary long word is never mistaken for one.
//
// Endpoints, tried in this order: SOLANA_RPC_URL (full URL, may hold a key,
// for example an Alchemy or Helius Solana URL), then free public endpoints.
// Dwellir has no Solana host that resolves (checked 2026-11-24), so it is not used.
// publicnode answers balances and transactions but refuses token reads without
// a personal token, so token supply needs SOLANA_RPC_URL or the public mainnet node. Keys are
// only ever placed in the request URL and are never logged or returned. Every
// call counts against the per-request budget from ankrRpc.js.

import { checkBudget } from './ankrRpc.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

// Byte length of a base58 string, or null when it has a character outside the
// alphabet. Leading "1"s are leading zero bytes.
export function base58ByteLength(text) {
  if (typeof text !== 'string' || !text) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  const bytes = [];
  for (let i = zeros; i < text.length; i += 1) {
    let carry = B58_INDEX.get(text[i]);
    if (carry === undefined) return null;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return zeros + bytes.length;
}

export function isSolanaAddress(text) {
  return typeof text === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) && base58ByteLength(text) === 32;
}

export function isSolanaSignature(text) {
  return typeof text === 'string' && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(text) && base58ByteLength(text) === 64;
}

const CANDIDATE_RE = /(?<![1-9A-HJ-NP-Za-km-z0-9_])[1-9A-HJ-NP-Za-km-z]{32,90}(?![1-9A-HJ-NP-Za-km-z0-9_])/g;

// Every address-shaped token in the text, in the order written, without
// duplicates. The 0x lookbehind is not needed: "0" is outside the alphabet, so
// a hex string never forms a whole base58 token.
export function extractSolanaAddresses(input) {
  if (typeof input !== 'string') return [];
  const out = [];
  for (const m of input.matchAll(CANDIDATE_RE)) {
    if (isSolanaAddress(m[0]) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

export function extractSolanaSignature(input) {
  if (typeof input !== 'string') return null;
  for (const m of input.matchAll(CANDIDATE_RE)) if (isSolanaSignature(m[0])) return m[0];
  return null;
}

const SOLANA_WORD_RE = /\b(?:solana|sol|spl|lamports?)\b/i;
const SOLANA_CHAIN_RE = /^\s*(?:solana|sol|solana[-_ ]?mainnet(?:[-_ ]?beta)?|mainnet[-_ ]beta)\s*$/i;
const EVM_ENTITY_RE = /0x[0-9a-fA-F]{40}/;

export function mentionsSolana(text) {
  return typeof text === 'string' && SOLANA_WORD_RE.test(text);
}

export function isSolanaChainParam(value) {
  return typeof value === 'string' && SOLANA_CHAIN_RE.test(value);
}

// True when this request is about Solana. A 0x address or hash anywhere in the
// request keeps it on the EVM path, whatever chain word comes with it, so every
// EVM answer stays exactly as it was. Otherwise Solana is chosen by the chain
// parameter, the word "Solana" or "SOL", or a real base58 address/signature.
export function wantsSolana(chainParam, ...texts) {
  const all = texts.filter((t) => typeof t === 'string');
  if (all.some((t) => EVM_ENTITY_RE.test(t))) return false;
  if (isSolanaChainParam(chainParam)) return true;
  return all.some((t) => mentionsSolana(t) || extractSolanaAddresses(t).length > 0 || extractSolanaSignature(t) !== null);
}

export const SOLANA_KNOWN_TOKENS = {
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, name: 'USD Coin' },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, name: 'Tether USD' },
  WSOL: { mint: 'So11111111111111111111111111111111111111112', decimals: 9, name: 'Wrapped SOL' },
};

export function knownSolanaTokenByMint(mint) {
  for (const [symbol, t] of Object.entries(SOLANA_KNOWN_TOKENS)) {
    if (t.mint === mint) return { symbol: symbol === 'WSOL' ? 'wSOL' : symbol, ...t };
  }
  return null;
}

// The well-known token named by symbol in the text ("USDC", "wSOL", "wrapped sol").
export function knownSolanaTokenFromText(text) {
  if (typeof text !== 'string') return null;
  const t = text.toUpperCase();
  const hit = (re) => re.test(t);
  if (hit(/(?<![A-Z0-9])USDC(?![A-Z0-9])|USD COIN/)) return knownSolanaTokenByMint(SOLANA_KNOWN_TOKENS.USDC.mint);
  if (hit(/(?<![A-Z0-9])USDT(?![A-Z0-9])|TETHER/)) return knownSolanaTokenByMint(SOLANA_KNOWN_TOKENS.USDT.mint);
  if (hit(/(?<![A-Z0-9])WSOL(?![A-Z0-9])|WRAPPED SOL/)) return knownSolanaTokenByMint(SOLANA_KNOWN_TOKENS.WSOL.mint);
  return null;
}

const TIMEOUT_MS = Number(process.env.SOLANA_CALL_TIMEOUT_MS) || 4_000;

// Endpoint list is read per call so a test or a restart can change it.
export function solanaEndpoints() {
  const list = [];
  if (process.env.SOLANA_RPC_URL) list.push(process.env.SOLANA_RPC_URL);
  list.push('https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com');
  return list;
}

export class SolanaRpcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SolanaRpcError';
  }
}

// Error messages must never carry a key: strip any URL path before surfacing.
function safeHost(url) {
  try { return new URL(url).host; } catch { return 'endpoint'; }
}

const cache = new Map();
const CACHE_MS = 8_000;
export function resetSolanaCache() { cache.clear(); }

async function callOne(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new SolanaRpcError(`${safeHost(url)} returned HTTP ${res.status}`);
  // Amounts above 2^53 (SOL supply in lamports) would lose digits as JSON
  // numbers, so long integers are quoted before parsing and read with BigInt.
  const body = JSON.parse((await res.text()).replace(/([:[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
  if (body.error) {
    const e = new SolanaRpcError(String(body.error.message ?? 'RPC error').slice(0, 200));
    e.rpcError = true;
    throw e;
  }
  return body.result;
}

// One JSON-RPC call, falling through the endpoint list on transport failures.
// A real RPC error (bad address, unknown account) is the answer and is thrown
// at once without trying the next endpoint.
export async function solanaRpc(method, params = []) {
  const key = `${method}:${JSON.stringify(params)}`;
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
  let last = null;
  for (const url of solanaEndpoints()) {
    checkBudget();
    try {
      const value = await callOne(url, method, params);
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      if (err.rpcError) throw err;
      last = err.name === 'SolanaRpcError' ? err : new SolanaRpcError(`${safeHost(url)} did not answer`);
    }
  }
  throw last ?? new SolanaRpcError('no Solana endpoint configured');
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;

// 1500000000n, 9 -> "1.5". Exact, no float rounding.
export function formatTokenAmount(raw, decimals) {
  const big = BigInt(raw);
  if (!decimals) return big.toString();
  const s = big.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export const solanaGetBalance = async (address) => (await solanaRpc('getBalance', [address, { commitment: 'confirmed' }])).value;
export const solanaGetTokenSupply = async (mint) => (await solanaRpc('getTokenSupply', [mint, { commitment: 'confirmed' }])).value;
export const solanaGetTokenLargest = async (mint) => (await solanaRpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }])).value;
export const solanaGetAccountInfo = async (address) => (await solanaRpc('getAccountInfo', [address, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
export const solanaGetSupply = async () => (await solanaRpc('getSupply', [{ commitment: 'confirmed', excludeNonCirculatingAccountsList: true }])).value;
export const solanaGetSlot = async () => solanaRpc('getSlot', [{ commitment: 'confirmed' }]);
export const solanaGetSignatureStatus = async (sig) => (await solanaRpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])).value?.[0] ?? null;
export const solanaGetTransaction = async (sig) => solanaRpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);

// Sum of a wallet's balance in one mint across all of its token accounts.
export async function solanaGetTokenBalance(owner, mint) {
  const result = await solanaRpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  let raw = 0n;
  let decimals = null;
  let accounts = 0;
  for (const row of result?.value ?? []) {
    const amt = row?.account?.data?.parsed?.info?.tokenAmount;
    if (!amt) continue;
    raw += BigInt(amt.amount);
    decimals = amt.decimals;
    accounts += 1;
  }
  return { raw, decimals, accounts };
}
