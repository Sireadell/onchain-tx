# ONCHAIN_TX_LOOKUP Miner — Build Spec

Status: v2 — five-chain. Originally frozen single-chain (one instance = one
chain, no `chain` param, matching Miner #1's pattern); revised 2026-08-14
after confirming via live docs + a competing registered miner's own
declared schema that `chain` is a miner-level API design choice, not a
protocol requirement — see `docs.telegraphprotocol.com/docs/miners/yaml-config`
(`input_schema`/`output_schema` are optional, caller-facing discovery
metadata only). One deployed instance now serves five allowlisted chains
behind one Ankr API key, selected via an explicit `chain` query param that
defaults to `eth` for backward compatibility with the original single-chain
callers.

## Identity

- kind: miner, protocol: generic
- Separate repo/deployment from Miner #1 (telegraph-forensics-fraud-detection).
- supported_intents: [ONCHAIN_TX_LOOKUP]
- Tier A — deterministic WASM exact-match scoring (per docs/using-telegraph/intents).
  This matters for design: the graded contract is the structured fields, not
  the prose. `summary` must stay factually consistent with them, but it isn't
  what wins or loses the score.

## Endpoint

- `GET /check-tx?tx_hash=0x...&chain=<chain>` — `tx_hash` required.
  `chain` optional, one of `eth` (default), `base`, `arbitrum`, `optimism`,
  `polygon`; an unrecognized value is a 400 validation error, never used to
  construct an RPC URL directly (static allowlist in `src/lib/chains.js`).
- Ankr per-chain URL segments live-verified 2026-08-14: `eth`, `base`,
  `arbitrum`, `polygon` all resolved real block numbers with the current
  key. `optimism` resolves to a real chain (identical response whether
  tried as `optimism`, `optimism_mainnet`, `op`, or `op_mainnet`) but the
  current `ANKR_API_KEY` isn't plan-enabled for it yet — a key-permission
  gap, not a URL-naming or architecture problem. Left in the allowlist;
  it 502s like any other transient upstream failure until access is
  granted, no special-casing needed in code.

## Signal Mapping — CORRECTED

Verified directly against the cached yaml-config schema reference
(`docs.telegraphprotocol.com/docs/miners/yaml-config`), not against the
adversarial-review pass, which asked for a `type` field:

```yaml
semantics:
  signal_mapping:
    label_field: status
    reason_field: summary
    confidence_field: confidence
  supported_intents:
    - ONCHAIN_TX_LOOKUP
```

**No `type` field.** The schema doc states outright: *"the signal_mapping
only accepts confidence_field, label_field, and reason_field. The type
field is not allowed."* Adding it isn't a style choice, it's a schema
violation — drop it. Everything else about the requested `signal_mapping`
shape (three named fields, all present on every response) is correct and
kept.

## Response Schema

Every response (success or failure) carries the three mapped fields:

- `status` (string, label_field) — the primary decision: e.g.
  `confirmed`, `reverted`, `pending`, `not_found`, `error`.
- `summary` (string, reason_field) — concise prose, must stay factually
  consistent with the structured fields below. Never asserts something the
  structured data doesn't support.
- `confidence` (number 0–1, confidence_field) — see semantics below.

Structured transaction fields (present when a transaction was found):

- `from` (address)
- `to` (address, **nullable** — null for contract-creation transactions)
- `value_wei` (decimal string)
- `block_number` (number, **nullable** — null while pending/no receipt)

No `canonical` field in v1. Checked: `on_chain.fields.*` in the yaml
schema reference arbitrary `source_path` values against whatever your
response body actually contains — there's no fixed required field name
the protocol schema demands. Nothing forces a `canonical` field to exist;
add it later only if a specific on_chain mapping needs it.

Scope note: this miner does not report internal (trace-level) transfers —
only the top-level tx + receipt. Don't phrase this as a disclosed
limitation in `summary` (no "internal transactions aren't available"
language) — it's simply out of scope, not a gap being flagged.

## Confidence Semantics

- Confirmed, deep enough that reorg risk is negligible (define a
  confirmation threshold, e.g. 12 blocks): `confidence: 1.0`, `status: confirmed`.
- Confirmed but shallow / recent (below the threshold): lower confidence
  (e.g. `0.6–0.8`), still `status: confirmed` — reason_field should say
  it's recent, not final.
- No receipt yet (in mempool or just not mined): `status: pending`,
  `confidence` low (e.g. `0.3`).
- Hash well-formed but not found anywhere the RPC can see: `status: not_found`,
  `confidence: 1.0` on the not-found claim itself (confident it isn't visible
  to this chain/node right now — not confident about *why*).
- Malformed hash (wrong length/format): reject before any RPC call,
  `status: error`, `confidence: 1.0`.
- Current block number unavailable (the best-effort `eth_blockNumber` call
  failed) OR current block is behind the transaction's block (negative
  depth — a stale/lagging RPC response, shouldn't happen but must degrade
  safely): `confidence: 0.8` exactly, `status` stays `confirmed`. Both are
  "we know it's confirmed, we just can't score how deep" cases, not
  something to phrase as a disclosed limitation in `summary`. Implemented
  in `confidenceForDepth()` (`src/lib/txStatus.js`), covered by
  `txStatus.test.js`.

## Transport — RPC Endpoint Design

Reusable from Miner #1's `walletActivity.js`, ported (not imported, this
is a separate deployment): retry policy (`RETRY_DELAYS_MS`,
`isRetryableFailure`), token-bucket rate limiter, RPC budget guard
(`withRpcBudget`/`checkBudget`), call-log diagnostics, and the caching
wrapper (generalized — Miner #1's cache key is
`method:address:pageSize:pageToken`, this miner's is `method:txHash`, no
pagination).

**Not reusable as-is:** `fetchAnkr()` posts to
`https://rpc.ankr.com/multichain/{apiKey}` and only ever sends
`ankr_`-namespaced Advanced API methods. This miner needs standard
JSON-RPC (`eth_getTransactionByHash`, `eth_getTransactionReceipt`), which
is a different Ankr product line.

**Design decision, live-verified 2026-08-14:** `fetchAnkrRpc(chainSegment,
method, params)` posts to `https://rpc.ankr.com/{chainSegment}/{apiKey}`
(per-chain standard endpoint), reusing the same retry/rate-limit/budget/
cache wrapper logic as `fetchAnkr`. Confirmed live for all five target
chains — see chain allowlist note under Endpoint above.

**Multi-chain additions to the transport layer:**

- `src/lib/chains.js` — static `CHAINS` allowlist (slug -> Ankr URL
  segment). The route layer resolves `chain` through this map only; an
  unrecognized value never reaches `fetch()`.
- Cache key changed from `method:params` to `chain:method:params`.
  `eth_blockNumber`'s params are always `[]`, so without the chain segment
  in the key every chain would read one shared cached block height — a
  real cross-chain correctness bug, not just an inefficiency. Covered by a
  test in `ankrRpc.test.js`.
- Rate limiter and RPC budget stay process-wide, not per-chain — Ankr's
  free-tier limit is per API key, and all five chains share one key here,
  so a shared token bucket is the correct model, not an oversight.
- `getTransactionByHash`/`getTransactionReceipt`/`getBlockNumber` in
  `checkTx.js` now run concurrently via one `Promise.all` (previously
  `blockNumber` ran sequentially after the other two, adding an
  unnecessary full RTT to every request). `blockNumber` keeps its
  independent `.catch(() => null)` so its failure can't reject the tx/
  receipt lookups too.
- Startup check (`index.js`) probes all five chains with a live
  `eth_blockNumber` call and only refuses to start if *every* chain is
  unreachable (a genuinely broken deployment, e.g. bad API key). A single
  chain being unreachable — e.g. Optimism pending Ankr plan access — logs
  a warning and the other four still serve traffic.

## Test Cases

1. Successful (confirmed) transaction
2. Reverted transaction
3. Contract creation (`to = null`)
4. Pending transaction / no receipt yet
5. Nonexistent transaction hash
6. Malformed transaction hash
7. Wrong-chain hash (valid format, not found on the configured chain)
8. Unsupported/unrecognized `chain` param — rejected before any RPC call
9. RPC timeout / failure
10. Rate-limit / budget exhaustion
11. Recent / reorg-sensitive transaction (shallow confirmation depth)
12. Old transaction / RPC history limitations
13. Zero-value transaction
14. Contract call (non-transfer `input` data)
15. Transaction types 0, 1, and 2 (EIP-4844 where relevant to the chain)
16. Same tx hash on two different chains does not cross-contaminate
    responses (cache isolation)

## Explicitly Out of Scope for This Pass

- No further miner-selection research.
- Intent decision (ONCHAIN_TX_LOOKUP) not reopened.
- No `canonical` field unless a concrete on_chain mapping requirement
  surfaces later.
- No chains beyond the five target chains (eth, base, arbitrum, optimism,
  polygon).
- No second RPC provider — Optimism's current gap is a key-permission
  issue to resolve on Ankr's dashboard, not a reason to add a new
  provider.
