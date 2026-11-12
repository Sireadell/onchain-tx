// Central config. Single place every module reads env from, so the rest
// of the codebase never touches process.env directly. Keep this a plain
// object of primitives, no side effects (no DB/RPC connections opened
// here).

export const config = {
  port: Number(process.env.PORT) || 3000,

  chain: process.env.CHAIN || 'eth',

  ankrApiKey: process.env.ANKR_API_KEY || '',
  ankrCallTimeoutMs: Number(process.env.ANKR_CALL_TIMEOUT_MS) || 8_000,

  // Ankr Advanced API token-bucket rate limiter, see
  // src/core/rpc/ankrClient.js. Frozen production value is 120 (Ankr
  // Premium PAYG plan), validated by the live benchmark referenced in
  // benchmark/README.md (0/18 429s, 0/18 retries, 0/18 deadline failures
  // at rate limit 120). Do not raise beyond the plan's confirmed ceiling
  // without re-benchmarking; that decision is locked, not this default.
  ankrRateLimitPerMin: Number(process.env.ANKR_RATE_LIMIT_PER_MIN) || 40,
  ankrRateLimitBurst: Number(process.env.ANKR_RATE_LIMIT_BURST) || 10,

  // Per-request RPC attempt ceiling (budget guard), see
  // src/core/rpc/ankrClient.js checkBudget().
  maxRpcAttempts: Number(process.env.MAX_RPC_ATTEMPTS) || 60,

  // Run-scoped in-process response cache TTL, see
  // src/core/rpc/ankrClient.js cachedFetch().
  rpcCacheTtlMs: Number(process.env.RPC_CACHE_TTL_MS) || 5 * 60_000,

  databaseUrl: process.env.DATABASE_URL || '',

  // Groq (OpenAI-compatible chat completions), used for LLM-answered
  // fraud-knowledge questions. Live leaderboard data pulled 2026-08-26
  // showed the top-ranked FRAUD_DETECTION miner (chainsight-oracle,
  // scoring 0.9-0.999) answers this way -- generating the answer
  // directly with an LLM -- rather than Wikipedia keyword search, which
  // was intermittently returning the wrong page or an empty result for
  // real live questions outside Sentinel's local benchmark set. Empty
  // string when unset disables this path entirely; fraudKnowledge.js
  // falls back to the existing Wikipedia lookup.
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  groqCallTimeoutMs: Number(process.env.GROQ_CALL_TIMEOUT_MS) || 8_000,
  fraudKnowledgeDeadlineMs: Number(process.env.FRAUD_KNOWLEDGE_DEADLINE_MS) || 12_000,
  fraudSafetyGuardsEnabled: process.env.FRAUD_SAFETY_GUARDS_ENABLED === 'true',

  knownExchangeAddresses: (process.env.KNOWN_EXCHANGE_ADDRESSES || '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.startsWith('0x')),

  // Internal hard cutoff for a single assessment request, see
  // docs/LOCKED_SPEC.md section 7. Deliberately well under Telegraph's
  // 30s protocol timeout, not right up against it.
  hardCutoffMs: Number(process.env.SENTINEL_HARD_CUTOFF_MS) || 22_000,

  // eth_getCode (and other raw eth_* methods) is not available on the
  // Ankr Advanced API plan this project is on -- confirmed live
  // 2026-08-20 and re-confirmed 2026-08-24 (see subjectApplicability.js,
  // contractControlRisk.js). eth_getCode is such a basic, universally
  // supported method that a free, unauthenticated public node handles it
  // fine; this project already trusts publicnode.com elsewhere (see the
  // on-chain registration scripts), so reusing it here for one narrow
  // purpose (contract bytecode/storage reads only, nothing budget- or
  // rate-limit-sensitive) is consistent, not a new trust boundary.
  // PUBLIC_RPC_URL is retained as an Ethereum-only legacy alias. It must
  // never follow CHAIN, because doing so could send a Base request to an
  // operator-supplied Ethereum node (or the reverse). New deployments
  // should use the explicit per-chain variables.
  ethereumPublicRpcUrl: process.env.ETH_PUBLIC_RPC_URL
    || process.env.PUBLIC_RPC_URL
    || 'https://ethereum-rpc.publicnode.com',
  basePublicRpcUrl: process.env.BASE_PUBLIC_RPC_URL || 'https://base-rpc.publicnode.com',
  publicRpcUrl: process.env.PUBLIC_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  publicRpcCallTimeoutMs: Number(process.env.PUBLIC_RPC_CALL_TIMEOUT_MS) || 5_000,
  optionalSignalDeadlineMs: Number(process.env.OPTIONAL_SIGNAL_DEADLINE_MS) || 2_500,

  // Ankr's per-chain JSON-RPC endpoint (rpc.ankr.com/{chain}/{key}) -- a
  // different Ankr product line from the /multichain/{key} Advanced API
  // ankrClient.js uses. Unlike that one, this per-chain endpoint does
  // serve standard eth_* calls (eth_call, eth_getCode, eth_getStorageAt)
  // on the same ANKR_API_KEY, live-verified working for eth/base/
  // arbitrum/polygon/optimism by the sibling telegraph-onchain-tx-lookup
  // project (see its src/lib/chains.js + ankrRpc.js). Preferred over the
  // free public node above since it's the same paid, authenticated key
  // already in use elsewhere in this project; publicRpcUrl stays as a
  // fallback if this one fails, not removed.
  ankrEthRpcUrl: process.env.ANKR_API_KEY
    ? `https://rpc.ankr.com/eth/${process.env.ANKR_API_KEY}`
    : '',
  ankrBaseRpcUrl: process.env.ANKR_API_KEY
    ? `https://rpc.ankr.com/base/${process.env.ANKR_API_KEY}`
    : '',
  // Legacy test and internal compatibility alias. Ethereum-only by
  // definition, regardless of CHAIN.
  ankrChainRpcUrl: process.env.ANKR_API_KEY
    ? `https://rpc.ankr.com/eth/${process.env.ANKR_API_KEY}`
    : '',
};

/**
 * Startup-time validation of required production configuration. Called
 * explicitly by src/index.js before the server starts listening, never on
 * module import, so importing config.js in tests never triggers this.
 * Deliberately does not touch /health or perform any RPC call: this is a
 * startup gate, not a readiness check.
 *
 * @returns {string[]} human-readable problems; empty array means OK
 */
export function validateProductionConfig() {
  const problems = [];
  if (!config.ankrApiKey) {
    problems.push(
      'ANKR_API_KEY is not set. Get one at ankr.com/rpc/advanced-api.'
    );
  }
  return problems;
}
