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
    CBBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
    WSTETH: { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', decimals: 18 },
    RETH: { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', decimals: 18 },
    EETH: { address: '0x35fA164735182de50811E8e2E824cFb9B6118ac2', decimals: 18 },
    ARB: { address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', decimals: 18 },
    LDO: { address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', decimals: 18 },
    CRV: { address: '0xD533a949740bb3306d119CC777fa900bA034cd52', decimals: 18 },
    USDE: { address: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', decimals: 18 },
    FRAX: { address: '0x853d955aCEf822Db058eb8505911ED77F175b99e', decimals: 18 },
    ENA: { address: '0x57e114B691Db790C35207b2e685D4A43181e6061', decimals: 18 },
  },
  base: {
    USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    CBBTC: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
    DAI: { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
    USDBC: { address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', decimals: 6 },
    CBETH: { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
    USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
    WSTETH: { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', decimals: 18 },
  },
  arbitrum: {
    USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    WETH: { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    WBTC: { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
    ARB: { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    LINK: { address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', decimals: 18 },
    UNI: { address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', decimals: 18 },
  },
  optimism: {
    USDC: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    USDT: { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
    DAI: { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    OP: { address: '0x4200000000000000000000000000000000000042', decimals: 18 },
    WBTC: { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', decimals: 8 },
  },
  polygon: {
    USDC: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
    USDT: { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    DAI: { address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
    WETH: { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
    WBTC: { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
    LINK: { address: '0xb0897686c545045aFc77CF20eC7A532E3120E0F1', decimals: 18 },
    AAVE: { address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', decimals: 18 },
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
