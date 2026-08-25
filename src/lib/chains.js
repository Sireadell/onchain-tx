// Static allowlist of supported chains. `chain` request params resolve
// through this map only — never used to construct an RPC URL directly, so
// an unrecognized chain fails validation before any network call.
//
// `segment` is the literal Ankr per-chain URL path segment
// (rpc.ankr.com/{segment}/{key}), live-verified 2026-08-14 against the
// real Ankr endpoint for all five (eth/base/arbitrum/polygon returned real
// block numbers; optimism resolved to a real chain but the current
// ANKR_API_KEY isn't plan-enabled for it — same "optimism" segment name,
// confirmed by testing optimism/optimism_mainnet/op/op_mainnet and getting
// the identical permission error for all four, not a 404-style unknown-chain
// error. Left enabled here since it's a key-permission issue, not an
// architectural one — it'll 502 like any other transient upstream failure
// until Ankr access is granted, no special-casing needed.
// `blockscoutHost` is the live Blockscout instance for each chain, used by
// the TOKEN_HOLDER_COUNT endpoint (Blockscout's REST API, not Ankr's
// JSON-RPC — no API key needed). Live-verified 2026-08-18 by hitting
// /api/v2/tokens/{address} for USDC on each chain. `optimism.blockscout.com`
// 301-redirects to `explorer.optimism.io` (Optimism's own Blockscout
// deployment, not the shared blockscout.com domain the other four use) —
// hardcoded to the real host directly rather than following a redirect on
// every request.
// `nativeCoingeckoId` is the CoinGecko id (as recognized by DefiLlama's
// coins.llama.fi) for each chain's native gas token, used by /gas-price to
// convert gwei into a USD fee estimate. eth/base/arbitrum/optimism all
// settle gas in ETH. Polygon's native token is POL (post-MATIC rename);
// live-checked 2026-08-25 against coins.llama.fi — `matic-network` returns
// an empty `coins` object there, `polygon-ecosystem-token` is the id that
// actually resolves.
export const CHAINS = {
  eth: { segment: 'eth', label: 'Ethereum', blockscoutHost: 'eth.blockscout.com', nativeCoingeckoId: 'ethereum' },
  base: { segment: 'base', label: 'Base', blockscoutHost: 'base.blockscout.com', nativeCoingeckoId: 'ethereum' },
  arbitrum: { segment: 'arbitrum', label: 'Arbitrum', blockscoutHost: 'arbitrum.blockscout.com', nativeCoingeckoId: 'ethereum' },
  optimism: { segment: 'optimism', label: 'Optimism', blockscoutHost: 'explorer.optimism.io', nativeCoingeckoId: 'ethereum' },
  polygon: { segment: 'polygon', label: 'Polygon', blockscoutHost: 'polygon.blockscout.com', nativeCoingeckoId: 'polygon-ecosystem-token' },
};

export const DEFAULT_CHAIN = process.env.CHAIN || 'eth';

export function resolveChain(chain) {
  return CHAINS[chain] ?? null;
}
