// Parsing and decoding for ONCHAIN_METRIC_VERIFY: which contract view, storage
// slot or balance a free-text question asks for, at which block, and how to
// turn the raw return words into a plain answer. No network calls here.
// Selectors were computed with keccak256 on 2026-11-03 (not typed by hand).

const FUNCTIONS = {
  owner: { selector: '0x8da5cb5b', args: [], out: 'address', phrase: /\b(?:contract\s+)?owner\b(?!\s+of)/i },
  totalSupply: { selector: '0x18160ddd', args: [], out: 'uint', phrase: /\btotal\s*supply\b/i },
  decimals: { selector: '0x313ce567', args: [], out: 'uint', phrase: /\bdecimals\b/i },
  symbol: { selector: '0x95d89b41', args: [], out: 'string', phrase: /\bsymbol\b/i },
  name: { selector: '0x06fdde03', args: [], out: 'string', phrase: null },
  balanceOf: { selector: '0x70a08231', args: ['address'], out: 'uint', phrase: null },
  totalAssets: { selector: '0x01e1d114', args: [], out: 'uint', phrase: /\btotal\s*assets\b/i },
  paused: { selector: '0x5c975abb', args: [], out: 'bool', phrase: /\bpaused\b/i },
  latestAnswer: { selector: '0x50d25bcd', args: [], out: 'int', phrase: null },
  latestRoundData: { selector: '0xfeaf968c', args: [], out: 'round', phrase: /\b(?:price\s*feed|oracle|chainlink|aggregator|round\s*data)\b/i },
  getReserves: { selector: '0x0902f1ac', args: [], out: 'reserves', phrase: /\breserves\b/i },
  slot0: { selector: '0x3850c7bd', args: [], out: 'slot0', phrase: /\b(?:slot0|sqrtPriceX96|current\s+tick)\b/i },
  convertToShares: { selector: '0xc6e6f592', args: ['uint'], out: 'uint', phrase: null },
  convertToAssets: { selector: '0x07a2d13a', args: ['uint'], out: 'uint', phrase: null },
  ownerOf: { selector: '0x6352211e', args: ['uint'], out: 'address', phrase: /\b(?:who\s+(?:owns|held)|owner\s+of|which\s+wallet\s+held|holder\s+of)\b/i },
  allowance: { selector: '0xdd62ed3e', args: ['address', 'address'], out: 'uint', phrase: null },
  token0: { selector: '0x0dfe1681', args: [], out: 'address', phrase: null },
  token1: { selector: '0xd21220a7', args: [], out: 'address', phrase: null },
  liquidity: { selector: '0x1a686502', args: [], out: 'uint', phrase: null },
  description: { selector: '0x7284e416', args: [], out: 'string', phrase: null },
  pricePerShare: { selector: '0x99530b06', args: [], out: 'uint', phrase: null },
  getPricePerFullShare: { selector: '0x77c7b8fc', args: [], out: 'uint', phrase: null },
  totalBorrows: { selector: '0x47bd3718', args: [], out: 'uint', phrase: null },
  totalReserves: { selector: '0x8f840ddd', args: [], out: 'uint', phrase: null },
  exchangeRateStored: { selector: '0x182df0f5', args: [], out: 'uint', phrase: null },
  implementation: { selector: '0x5c60da1b', args: [], out: 'address', phrase: null },
  admin: { selector: '0xf851a440', args: [], out: 'address', phrase: null },
  fee: { selector: '0xddca3f43', args: [], out: 'uint', phrase: null },
  threshold: { selector: '0x42cde4e8', args: [], out: 'uint', phrase: null },
  getThreshold: { selector: '0xe75235b8', args: [], out: 'uint', phrase: null },
  totalDebt: { selector: '0xfc7b9c18', args: [], out: 'uint', phrase: null },
  totalStaked: { selector: '0x817b1cd2', args: [], out: 'uint', phrase: null },
  rewardRate: { selector: '0x7b0a47ee', args: [], out: 'uint', phrase: null },
  epoch: { selector: '0x900cf0cf', args: [], out: 'uint', phrase: null },
  totalShares: { selector: '0x3a98ef39', args: [], out: 'uint', phrase: null },
  getTotalShares: { selector: '0xd5002f2e', args: [], out: 'uint', phrase: null },
  getTotalPooledEther: { selector: '0x37cfdaca', args: [], out: 'uint', phrase: null },
  maxSupply: { selector: '0xd5abeb01', args: [], out: 'uint', phrase: null },
  cap: { selector: '0x355274ea', args: [], out: 'uint', phrase: null },
  totalValueLocked: { selector: '0xec18154e', args: [], out: 'uint', phrase: null },
  totalLiquidity: { selector: '0x15770f92', args: [], out: 'uint', phrase: null },
};

export const SUPPORTED_FUNCTIONS = Object.keys(FUNCTIONS);

const ADDRESS_RE = /0x[0-9a-fA-F]{40}\b/g;
const BLOCK_NUM = String.raw`(\d{1,3}(?:[,_]\d{3})+|\d{4,})`;

export function addressesIn(text) {
  return [...new Set((String(text ?? '').match(ADDRESS_RE) ?? []))];
}

export function blockFromText(text) {
  const clean = String(text ?? '').replace(/0x[0-9a-fA-F]{40,}/g, ' ');
  const m = clean.match(new RegExp(String.raw`\bblock(?:\s+(?:number|height))?\s*#?\s*${BLOCK_NUM}`, 'i'))
    ?? clean.match(new RegExp(String.raw`\bat\s+(?:height|number)\s+${BLOCK_NUM}`, 'i'))
    ?? clean.match(new RegExp(String.raw`${BLOCK_NUM}\s*(?:th\s+)?block\b`, 'i'));
  return m ? m[1].replace(/[,_]/g, '') : null;
}

export function slotFromText(text) {
  const m = String(text ?? '').match(/\b(?:storage\s+)?(?:slot|position|index)\s+(0x[0-9a-fA-F]+|\d+)\b/i);
  if (!m) return null;
  const v = m[1].startsWith('0x') ? BigInt(m[1]) : BigInt(m[1]);
  return `0x${v.toString(16)}`;
}

function parseScalar(token) {
  const t = String(token).trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return { type: 'address', value: t.toLowerCase() };
  if (/^\d+(?:\.\d+)?e\d+$/i.test(t)) {
    const [mant, exp] = t.toLowerCase().split('e');
    const [whole, frac = ''] = mant.split('.');
    const shift = Number(exp) - frac.length;
    return shift >= 0 ? { type: 'uint', value: BigInt(whole + frac) * 10n ** BigInt(shift) } : null;
  }
  if (/^0x[0-9a-fA-F]+$/.test(t)) return { type: 'uint', value: BigInt(t) };
  if (/^\d[\d_,]*$/.test(t)) return { type: 'uint', value: BigInt(t.replace(/[,_]/g, '')) };
  return null;
}

// Every "name(args)" the text mentions that is a function we know how to read.
export function explicitCalls(text) {
  const out = [];
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const def = FUNCTIONS[m[1]];
    if (!def) continue;
    const args = m[2].split(',').map((s) => s.trim()).filter(Boolean).map(parseScalar);
    if (args.some((a) => a === null)) continue;
    if (!out.some((c) => c.name === m[1] && JSON.stringify(c.args.map((a) => String(a.value))) === JSON.stringify(args.map((a) => String(a.value))))) {
      out.push({ name: m[1], args });
    }
  }
  return out;
}

// Plain-words questions: "who owns BAYC id 100", "what is the total supply".
export function phraseCalls(text) {
  const t = String(text ?? '');
  const out = [];
  for (const [name, def] of Object.entries(FUNCTIONS)) {
    if (def.phrase && def.phrase.test(t)) out.push({ name, args: [] });
  }
  // "owner" and "owner of" overlap: keep ownerOf only when its phrase fired.
  const hasOwnerOf = out.some((c) => c.name === 'ownerOf');
  return out.filter((c) => !(hasOwnerOf && c.name === 'owner'));
}

// Fills missing arguments from the rest of the question.
export function completeArgs(call, text, contract) {
  const def = FUNCTIONS[call.name];
  if (call.args.length === def.args.length) return call;
  const others = addressesIn(text).filter((a) => a.toLowerCase() !== String(contract).toLowerCase());
  const args = [];
  const ids = [...String(text ?? '').replace(ADDRESS_RE, ' ').matchAll(/\b(?:token\s*)?(?:id|#|token)\s*#?\s*(\d+)\b/gi)].map((m) => m[1]);
  let addrIdx = 0;
  for (const type of def.args) {
    if (type === 'address') {
      if (!others[addrIdx]) return null;
      args.push({ type, value: others[addrIdx++].toLowerCase() });
    } else {
      if (!ids.length) return null;
      args.push({ type, value: BigInt(ids.shift()) });
    }
  }
  return { name: call.name, args };
}

export function encodeCall(call) {
  const def = FUNCTIONS[call.name];
  const words = call.args.map((a) => (a.type === 'address' ? a.value.slice(2).padStart(64, '0') : a.value.toString(16).padStart(64, '0')));
  return `${def.selector}${words.join('')}`;
}

export function signatureText(call) {
  const shown = call.args.map((a) => (a.type === 'address' ? a.value : a.value.toString()));
  return `${call.name}(${shown.join(', ')})`;
}

const wordAt = (hex, i) => `0x${String(hex).slice(2 + i * 64, 2 + (i + 1) * 64)}`;
const asUint = (w) => BigInt(w);
const asInt = (w, bits = 256) => BigInt.asIntN(bits, BigInt(w));
const asAddress = (w) => `0x${w.slice(-40)}`;

function decodeString(hex) {
  const body = String(hex).slice(2);
  try {
    if (body.length === 64) return Buffer.from(body, 'hex').toString('utf8').replace(/\0+$/, '');
    const len = Number(BigInt(`0x${body.slice(64, 128)}`));
    return Buffer.from(body.slice(128, 128 + len * 2), 'hex').toString('utf8');
  } catch { return null; }
}

// Returns { value, fields } where value is the plain-text result.
export function decodeResult(name, hex, { feedDecimals = null } = {}) {
  const def = FUNCTIONS[name];
  if (!hex || hex === '0x') return null;
  switch (def.out) {
    case 'uint': return { value: asUint(wordAt(hex, 0)).toString(), fields: { uint: asUint(wordAt(hex, 0)).toString() } };
    case 'int': {
      const raw = asInt(wordAt(hex, 0));
      return { value: raw.toString(), fields: { int: raw.toString() } };
    }
    case 'address': return { value: asAddress(wordAt(hex, 0)), fields: {} };
    case 'bool': return { value: asUint(wordAt(hex, 0)) === 0n ? 'false' : 'true', fields: {} };
    case 'string': { const s = decodeString(hex); return s === null ? null : { value: s, fields: {} }; }
    case 'round': {
      const answer = asInt(wordAt(hex, 1));
      const scaled = feedDecimals === null ? null : scaleInt(answer, feedDecimals);
      const rest = `raw answer ${answer}, round ${asUint(wordAt(hex, 0))}, timestamp ${asUint(wordAt(hex, 3))}`;
      return { value: scaled === null ? rest : `${scaled}; ${rest}`, fields: { answer: answer.toString(), updated_at: asUint(wordAt(hex, 3)).toString() } };
    }
    case 'reserves': {
      const r0 = asUint(wordAt(hex, 0)); const r1 = asUint(wordAt(hex, 1));
      return { value: `reserve0 ${r0}, reserve1 ${r1}, last update timestamp ${asUint(wordAt(hex, 2))}`, fields: { reserve0: r0.toString(), reserve1: r1.toString() } };
    }
    case 'slot0': {
      const sqrt = asUint(wordAt(hex, 0)); const tick = asInt(wordAt(hex, 1), 24);
      return { value: `sqrtPriceX96 ${sqrt} and tick ${tick}`, fields: { sqrtPriceX96: sqrt.toString(), tick: tick.toString() } };
    }
    default: return null;
  }
}

function scaleInt(value, decimals) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
}
