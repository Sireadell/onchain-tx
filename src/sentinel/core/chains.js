import { config } from '../config.js';

export const CHAINS = Object.freeze({
  eth: Object.freeze({ key: 'eth', chainId: 1, name: 'Ethereum', publicRpcUrl: 'https://ethereum-rpc.publicnode.com' }),
  base: Object.freeze({ key: 'base', chainId: 8453, name: 'Base', publicRpcUrl: 'https://base-rpc.publicnode.com' }),
});

export const SUPPORTED_CHAIN_KEYS = Object.freeze(Object.keys(CHAINS));

export function normalizeChain(value) {
  const chain = String(value ?? 'eth').trim().toLowerCase();
  return Object.hasOwn(CHAINS, chain) ? chain : null;
}

export function getChainConfig(value) {
  const chain = normalizeChain(value);
  return chain ? CHAINS[chain] : null;
}

export function publicRpcUrlsForChain(chain, explicitUrl) {
  if (explicitUrl) return [explicitUrl];
  const selected = getChainConfig(chain);
  if (!selected) return [];
  const ankrUrl = selected.key === 'eth'
    ? (config.ankrEthRpcUrl || config.ankrChainRpcUrl)
    : config.ankrBaseRpcUrl;
  const configuredFallback = selected.key === 'eth'
    ? config.ethereumPublicRpcUrl
    : config.basePublicRpcUrl;
  return [...new Set([ankrUrl, configuredFallback, selected.publicRpcUrl].filter(Boolean))];
}
