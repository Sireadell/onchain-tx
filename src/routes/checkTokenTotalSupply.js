// TOKEN_TOTAL_SUPPLY_VERIFY signal endpoint: an ERC-20 token's total
// supply read straight from the chain with totalSupply(), at the latest
// block or at a block the caller names. The graded rounds ask about an
// Ethereum token and name the chain in several spellings ("ethereum",
// "eth-mainnet", "eth_mainnet", "1"), which is what knocked the two
// specialist miners out with "unknown supply venue"; resolveChainId below
// accepts all of them.

import { Router } from 'express';
import { ethCall, withRpcBudget } from '../lib/ankrRpc.js';
import { resolveRpcChainLoose, CHAINS } from '../lib/chains.js';
import { extractAddress, firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { KNOWN_TOKENS, decodeUint, decodeAbiString } from '../lib/knownTokens.js';

const router = Router();

const TOKEN_NAMES = { TETHER: 'USDT', 'USD COIN': 'USDC', CHAINLINK: 'LINK', UNISWAP: 'UNI', 'WRAPPED ETHER': 'WETH', 'WRAPPED BITCOIN': 'WBTC', MAKER: 'MKR', 'LIDO STAKED ETHER': 'STETH' };

const CHAIN_IDS = { 1: 'eth', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon', 43114: 'avalanche' };

export function resolveChainId(value) {
  if (value === undefined || value === null || String(value).trim() === '') return CHAINS.eth;
  const text = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (/^\d+$/.test(text)) return CHAINS[CHAIN_IDS[text]] ?? null;
  return resolveRpcChainLoose(text) ?? resolveRpcChainLoose(text.replace(/\s*mainnet$/, ''));
}

export function tokenFromText(text, chainKey) {
  const table = KNOWN_TOKENS[chainKey] ?? {};
  const upper = String(text ?? '').toUpperCase();
  for (const [name, sym] of Object.entries(TOKEN_NAMES)) if (upper.includes(name)) return { symbol: sym, address: table[sym]?.address ?? null };
  for (const sym of Object.keys(table)) if (new RegExp(`(?:^|[^A-Z])${sym}(?:$|[^A-Z])`).test(upper)) return { symbol: sym, address: table[sym].address };
  return null;
}

function parseBlock(value, text) {
  const raw = firstUsableValue(value);
  if (raw !== undefined && !/^latest$/i.test(String(raw).trim())) {
    const digits = String(raw).replace(/[,_\s]/g, '');
    if (/^0x[0-9a-f]+$/i.test(digits) || /^\d+$/.test(digits)) return BigInt(digits).toString();
  }
  const m = String(text ?? '').match(/\bblock(?:\s+(?:number|height))?\s*#?\s*([\d,_]{4,})/i);
  return m ? m[1].replace(/[,_]/g, '') : 'latest';
}

export function formatUnits(raw, decimals) {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

function withCommas(decimalString) {
  const [whole, frac] = decimalString.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac.slice(0, 6)}` : grouped;
}

async function readSupply(chain, token, block) {
  const [supplyHex, decimalsHex, symbolHex] = await Promise.all([
    ethCall(chain.segment, token, '0x18160ddd', block),
    ethCall(chain.segment, token, '0x313ce567', 'latest').catch(() => null),
    ethCall(chain.segment, token, '0x95d89b41', 'latest').catch(() => null),
  ]);
  return { supply: decodeUint(supplyHex), decimals: decodeUint(decimalsHex), symbol: decodeAbiString(symbolHex) };
}

async function handleTokenTotalSupply(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const text = freeTextParam(params) ?? '';
  const chainRaw = firstUsableValue(params.chain, params.venue, params.network, params.chain_id, params.chainId);
  const chain = resolveChainId(chainRaw ?? (resolveRpcChainLoose(text) ? text : undefined));
  if (!chain) {
    return respondUnusableInput(res, `${quoteParam(chainRaw)} is not a chain I can read. Pass chain as one of ethereum, base, arbitrum, polygon, avalanche (or a chain id such as 1).`);
  }

  const tokenRaw = firstUsableValue(params.token, params.contract, params.token_address, params.address, params.contract_address, params.mint, params.symbol);
  let token = extractAddress(String(tokenRaw ?? '')) ?? extractAddress(text);
  let knownSymbol = null;
  if (!token) {
    const named = tokenFromText(`${tokenRaw ?? ''} ${text}`, chain.key);
    if (named?.address) { token = named.address; knownSymbol = named.symbol; }
  }
  if (!token) {
    return respondUnusableInput(res, 'I cannot read a total supply because no token contract was supplied. Pass token as a 0x contract address, or a well-known symbol such as USDC.');
  }

  const block = parseBlock(firstUsableValue(params.block, params.block_number, params.blockNumber, params.height), text);

  let read;
  let blockUsed = block;
  let note = null;
  try {
    read = await withRpcBudget(() => readSupply(chain, token, block));
  } catch (err) {
    if (block === 'latest') {
      return res.status(502).json({ status: 'error', summary: `The ${chain.label} RPC did not answer for ${token}. Retry shortly.`, confidence: 0, error: err.message });
    }
    try {
      read = await withRpcBudget(() => readSupply(chain, token, 'latest'));
      blockUsed = 'latest';
      note = `Historical state at block ${block} was not available from the RPC, so this is the supply at the latest block.`;
    } catch (err2) {
      return res.status(502).json({ status: 'error', summary: `The ${chain.label} RPC did not answer for ${token}. Retry shortly.`, confidence: 0, error: err2.message });
    }
  }

  if (read.supply === null) {
    return respondUnusableInput(res, `${token} on ${chain.label} did not answer totalSupply(), so it is not an ERC-20 token contract there.`);
  }

  const decimals = read.decimals === null ? 18 : Number(read.decimals);
  const symbol = read.symbol ?? knownSymbol ?? 'tokens';
  const supply = formatUnits(read.supply, decimals);
  const at = blockUsed === 'latest' ? 'at the latest block' : `at block ${blockUsed}`;
  const summary = `The total supply of ${symbol} (${token}) on ${chain.label} is ${withCommas(supply)} ${symbol} ${at} (raw ${read.supply.toString()} with ${decimals} decimals), read on-chain with totalSupply().${note ? ` ${note}` : ''}`;

  res.json({
    status: 'ok',
    summary,
    confidence: note ? 0.7 : 0.95,
    canonical: ['token-total-supply', chain.key, token.toLowerCase(), blockUsed].join(':'),
    chain: chain.key,
    token,
    symbol,
    decimals,
    total_supply: supply,
    total_supply_raw: read.supply.toString(),
    block: blockUsed,
    source: `${chain.label} RPC eth_call totalSupply()`,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleTokenTotalSupply(req, res));
router.post('/', (req, res) => handleTokenTotalSupply(req, res));

export default router;
