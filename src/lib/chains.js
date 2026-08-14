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
export const CHAINS = {
  eth: { segment: 'eth', label: 'Ethereum' },
  base: { segment: 'base', label: 'Base' },
  arbitrum: { segment: 'arbitrum', label: 'Arbitrum' },
  optimism: { segment: 'optimism', label: 'Optimism' },
  polygon: { segment: 'polygon', label: 'Polygon' },
};

export const DEFAULT_CHAIN = process.env.CHAIN || 'eth';

export function resolveChain(chain) {
  return CHAINS[chain] ?? null;
}
