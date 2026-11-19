// Extra chain reads for ONCHAIN_METRIC_VERIFY that the shared ankrRpc.js does
// not offer: event logs (eth_getLogs) and an account's nonce
// (eth_getTransactionCount). Same providers as ankrRpc.js (Dwellir first when
// its key is set, then Ankr), and every attempt is counted against the shared
// per-request budget through checkBudget(). Also builds selectors for any view
// a question names (keccak256 of the signature) and reads its return words.

import { id as keccakUtf8 } from 'ethers';
import { checkBudget, ApiKeyMissingError } from './ankrRpc.js';

const DWELLIR_HOSTS = {
  eth: 'api-ethereum-mainnet.n.dwellir.com',
  base: 'api-base-mainnet-archive.n.dwellir.com',
  arbitrum: 'api-arbitrum-mainnet-archive.n.dwellir.com',
  optimism: 'api-optimism-mainnet-archive.n.dwellir.com',
  polygon: 'api-polygon-mainnet.n.dwellir.com',
};
const CALL_TIMEOUT_MS = 5_000;

async function post(url, method, params) {
  checkBudget();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC request failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

export async function rawRpc(chainSegment, method, params) {
  const dKey = process.env.DWELLIR_API_KEY;
  const host = DWELLIR_HOSTS[chainSegment];
  if (dKey && host) {
    try {
      return await post(`https://${host}/${dKey}`, method, params);
    } catch (err) {
      if (err?.name === 'RpcBudgetExceededError') throw err;
    }
  }
  const key = process.env.ANKR_API_KEY;
  if (!key) throw new ApiKeyMissingError('ANKR_API_KEY is not set.');
  return post(`https://rpc.ankr.com/${chainSegment}/${key}`, method, params);
}

const tag = (block) => (block === 'latest' ? 'latest' : `0x${BigInt(block).toString(16)}`);

export async function getLogs(chainSegment, { address, topics, fromBlock, toBlock }) {
  return rawRpc(chainSegment, 'eth_getLogs', [{ address, topics, fromBlock: tag(fromBlock), toBlock: tag(toBlock) }]);
}

export async function getTransactionCountAt(chainSegment, address, block = 'latest') {
  return rawRpc(chainSegment, 'eth_getTransactionCount', [address, tag(block)]);
}

// keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// "delay()", "getRoleAdmin(0x..)", "balanceOf(0xabc)" with any name: the
// argument types are read from the values given (an address, else uint256).
export function genericCalls(text, known = new Set()) {
  const out = [];
  // No space before "(": "USDC (0x..)" is prose, "delay()" is a call.
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const name = m[1];
    if (known.has(name) || /^(?:in|at|on|for|of|and|or|e\.?g|i\.?e|USDC|USDT|block|see)$/i.test(name)) continue;
    const parts = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    const args = [];
    let bad = false;
    for (const p of parts) {
      if (/^0x[0-9a-fA-F]{40}$/.test(p)) args.push({ type: 'address', value: p.toLowerCase() });
      else if (/^0x[0-9a-fA-F]{64}$/.test(p)) args.push({ type: 'bytes32', value: p.toLowerCase() });
      else if (/^\d[\d_,]*$/.test(p)) args.push({ type: 'uint256', value: BigInt(p.replace(/[,_]/g, '')) });
      else if (/^(?:true|false)$/i.test(p)) args.push({ type: 'bool', value: /^true$/i.test(p) });
      else { bad = true; break; }
    }
    if (bad) continue;
    if (!out.some((c) => c.name === name)) out.push({ name, args });
  }
  return out;
}

export function genericSignature(call) {
  return `${call.name}(${call.args.map((a) => a.type).join(',')})`;
}

export function genericSelector(call) {
  return keccakUtf8(genericSignature(call)).slice(0, 10);
}

export function encodeGeneric(call) {
  const words = call.args.map((a) => {
    if (a.type === 'address') return a.value.slice(2).padStart(64, '0');
    if (a.type === 'bytes32') return a.value.slice(2);
    if (a.type === 'bool') return (a.value ? '1' : '0').padStart(64, '0');
    return a.value.toString(16).padStart(64, '0');
  });
  return `${genericSelector(call)}${words.join('')}`;
}

export function genericCallText(call) {
  return `${call.name}(${call.args.map((a) => String(a.value)).join(', ')})`;
}

function humanDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const units = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const parts = [];
  let left = s;
  for (const [name, size] of units) {
    const n = Math.floor(left / size);
    if (n) { parts.push(`${n} ${name}${n === 1 ? '' : 's'}`); left -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

function tryString(body) {
  if (body.length < 128) return null;
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
  if (offset !== 32) return null;
  const len = Number(BigInt(`0x${body.slice(64, 128)}`));
  if (len === 0 || len > 1000 || body.length < 128 + len * 2) return null;
  const s = Buffer.from(body.slice(128, 128 + len * 2), 'hex').toString('utf8');
  return /^[\x20-\x7e -￿]+$/.test(s) ? s : null;
}

// The return type of an unknown view is not known, so the words are read in
// the most likely way: one word is an integer (and an address when it has
// the shape of one), a string is decoded when the layout says so, and longer
// returns are listed word by word.
export function decodeGeneric(hex, { wantsSeconds = false } = {}) {
  if (!hex || hex === '0x') return null;
  const body = String(hex).slice(2);
  if (body.length === 64) {
    const v = BigInt(`0x${body}`);
    const looksAddress = body.slice(0, 24) === '0'.repeat(24) && v >= 2n ** 128n;
    if (looksAddress) return { value: `0x${body.slice(24)}`, fields: { type: 'address', uint: v.toString() } };
    const dur = wantsSeconds ? humanDuration(v) : null;
    const text = `${v}${wantsSeconds ? ` seconds${dur ? ` (${dur})` : ''}` : ''}`;
    return { value: text, fields: { type: 'uint256', uint: v.toString(), ...(dur ? { duration: dur } : {}) } };
  }
  const s = tryString(body);
  if (s !== null) return { value: `"${s}"`, fields: { type: 'string', string: s } };
  const words = body.match(/.{64}/g) ?? [];
  const vals = words.slice(0, 8).map((w) => BigInt(`0x${w}`).toString());
  return { value: `words ${vals.join(', ')}`, fields: { type: 'words', words: vals } };
}

// Polygon and others use the same well-known token addresses; each was checked
// live with symbol() on 2026-11-19.
const KNOWN_TOKENS = {
  cbbtc: { eth: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', base: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', arbitrum: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' },
  usdc: { eth: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  usdt: { eth: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  weth: { eth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', base: '0x4200000000000000000000000000000000000006', optimism: '0x4200000000000000000000000000000000000006', arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  dai: { eth: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
  wbtc: { eth: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
};

// "What was the cbBTC balance held by 0x.." on a chain we know the token for.
export function tokenBalanceAsk(text, chainKey) {
  const m = String(text ?? '').match(/\b(cbBTC|USDC|USDT|WETH|DAI|WBTC)\b(?:\s+token)?\s+(?:balance|holdings?)\b/i)
    ?? String(text ?? '').match(/\b(?:balance|holdings?)\s+of\s+(cbBTC|USDC|USDT|WETH|DAI|WBTC)\b/i)
    ?? String(text ?? '').match(/\bhow\s+much\s+(cbBTC|USDC|USDT|WETH|DAI|WBTC)\b/i);
  if (!m) return null;
  const token = KNOWN_TOKENS[m[1].toLowerCase()]?.[chainKey];
  return token ? { symbol: m[1], token } : null;
}

// Well-known collections named without an address.
const KNOWN_CONTRACTS = [
  { re: /\b(?:BAYC|Bored\s+Ape\s+Yacht\s+Club)\b/i, name: 'BAYC', chain: 'eth', address: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D' },
  { re: /\b(?:MAYC|Mutant\s+Ape\s+Yacht\s+Club)\b/i, name: 'MAYC', chain: 'eth', address: '0x60E4d786628Fea6478F785A6d7e704777c86a7c6' },
  { re: /\bAzuki\b/i, name: 'Azuki', chain: 'eth', address: '0xED5AF388653567Af2F388E6224dC7C4b3241C544' },
];

export function knownContractName(address) {
  return KNOWN_CONTRACTS.find((k) => k.address.toLowerCase() === String(address ?? '').toLowerCase())?.name ?? null;
}

export function knownContractIn(text, chainKey) {
  const hit = KNOWN_CONTRACTS.find((k) => k.re.test(String(text ?? '')) && k.chain === chainKey);
  return hit ? hit.address : null;
}

// "between blocks 55,000,000 and 55,000,002", "from block X to Y", or one block.
export function blockRangeFromText(text) {
  const n = String.raw`(\d{1,3}(?:[,_]\d{3})+|\d{4,})`;
  const t = String(text ?? '').replace(/0x[0-9a-fA-F]{40,}/g, ' ');
  const m = t.match(new RegExp(String.raw`\bblocks?\s+${n}\s*(?:and|to|through|until|-)\s*(?:block\s+)?${n}`, 'i'))
    ?? t.match(new RegExp(String.raw`\bfrom\s+block\s+${n}\s+(?:to|through|until)\s+(?:block\s+)?${n}`, 'i'));
  if (!m) return null;
  const a = BigInt(m[1].replace(/[,_]/g, ''));
  const b = BigInt(m[2].replace(/[,_]/g, ''));
  return a <= b ? { from: a.toString(), to: b.toString() } : { from: b.toString(), to: a.toString() };
}

export function decodeTransferLog(log) {
  if (!log?.topics || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) return null;
  const addr = (w) => `0x${w.slice(-40)}`;
  const isNft = log.topics.length === 4;
  const raw = isNft ? BigInt(log.topics[3]) : BigInt(log.data && log.data !== '0x' ? log.data.slice(0, 66) : '0x0');
  return {
    from: addr(log.topics[1]),
    to: addr(log.topics[2]),
    value: raw,
    is_nft: isNft,
    token: log.address,
    tx_hash: log.transactionHash,
    block: BigInt(log.blockNumber).toString(),
    log_index: Number(BigInt(log.logIndex)),
  };
}
