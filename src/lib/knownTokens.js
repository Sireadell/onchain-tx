// Well-known ERC-20 contracts by chain, with their decimals, plus a reader
// for any other token's symbol and decimals. Shared by the total-supply
// route (symbol -> contract) and the transaction route (contract -> label,
// so a transfer call can say "the USDC token contract" and "100 USDC").
// Each address was checked live with symbol() on 2026-09-25.

import { ethCall } from './ankrRpc.js';

export const KNOWN_TOKENS = {
  eth: {
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    DAI: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    WBTC: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    LINK: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
    UNI: { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
    SHIB: { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
    PEPE: { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18 },
    AAVE: { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18 },
    MKR: { address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', decimals: 18 },
    STETH: { address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', decimals: 18 },
  },
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  },
};

export function knownTokenByAddress(chainKey, address) {
  const target = String(address ?? '').toLowerCase();
  for (const [symbol, t] of Object.entries(KNOWN_TOKENS[chainKey] ?? {})) {
    if (t.address.toLowerCase() === target) return { symbol: symbol === 'STETH' ? 'stETH' : symbol, decimals: t.decimals };
  }
  return null;
}

export function decodeUint(hex) {
  if (!hex || hex === '0x') return null;
  return BigInt(hex);
}

export function decodeAbiString(hex) {
  if (!hex || hex === '0x') return null;
  const body = hex.slice(2);
  try {
    if (body.length === 64) return Buffer.from(body, 'hex').toString('utf8').replace(/\0+$/, '') || null;
    const len = Number(BigInt(`0x${body.slice(64, 128)}`));
    return Buffer.from(body.slice(128, 128 + len * 2), 'hex').toString('utf8') || null;
  } catch {
    return null;
  }
}

// Symbol and decimals for any token: the table first, then the chain.
// Returns null when the contract answers neither (not an ERC-20).
export async function readTokenMeta(chain, address) {
  const known = knownTokenByAddress(chain.key, address);
  if (known) return known;
  const [dec, sym] = await Promise.all([
    ethCall(chain.segment, address, '0x313ce567').catch(() => null),
    ethCall(chain.segment, address, '0x95d89b41').catch(() => null),
  ]);
  const decimals = decodeUint(dec);
  if (decimals === null) return null;
  return { symbol: decodeAbiString(sym) ?? 'tokens', decimals: Number(decimals) };
}

// transfer(address,uint256) and transferFrom(address,address,uint256)
// calldata, the two token movements a lookup most often needs to name.
export function decodeTokenTransfer(input) {
  const data = String(input ?? '').toLowerCase();
  const word = (i) => data.slice(10 + i * 64, 10 + (i + 1) * 64);
  const addr = (w) => `0x${w.slice(24)}`;
  if (data.startsWith('0xa9059cbb') && data.length >= 138) {
    return { to: addr(word(0)), amount: BigInt(`0x${word(1)}`) };
  }
  if (data.startsWith('0x23b872dd') && data.length >= 202) {
    return { from: addr(word(0)), to: addr(word(1)), amount: BigInt(`0x${word(2)}`) };
  }
  return null;
}
