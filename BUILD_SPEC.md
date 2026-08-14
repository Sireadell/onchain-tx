# ONCHAIN_TX_LOOKUP Miner — Frozen Build Spec

Status: frozen for implementation. One item downgraded from blocker to
first-implementation-step verification (see Transport section). One
requested field rejected as invalid against the actual schema (see
Signal Mapping section) — flagging that explicitly since it contradicts
the last adversarial-review pass.

## Identity

- kind: miner, protocol: generic
- Separate repo/deployment from Miner #1 (telegraph-forensics-fraud-detection) —
  same reasoning as that miner's chain-per-instance rule: one deployed
  instance answers for one chain, no per-request chain branching.
- supported_intents: [ONCHAIN_TX_LOOKUP]
- Tier A — deterministic WASM exact-match scoring (per docs/using-telegraph/intents).
  This matters for design: the graded contract is the structured fields, not
  the prose. `summary` must stay factually consistent with them, but it isn't
  what wins or loses the score.

## Endpoint

- `GET /check-tx?tx_hash=0x...` — single required param, EVM tx hash.
- No `chain` param — chain is fixed per deployed instance (env var), same
  pattern as Miner #1's `CHAIN`.

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

**Design decision:** add a sibling `fetchAnkrRpc(method, params)` posting
to `https://rpc.ankr.com/{chain}/{apiKey}` (per-chain standard endpoint),
reusing the same retry/rate-limit/budget/cache wrapper logic as
`fetchAnkr`. This is based on Ankr's documented product split (Advanced
API multichain convenience endpoint vs. per-chain standard JSON-RPC
endpoint) — high confidence, but **not** live-verified this session the
way the 50/min rate limit figure was (that one's a comment in
`walletActivity.js` citing a direct docs check on 2026-08-12; this one
isn't, the docs page returned client-rendered boilerplate via curl and I
didn't push further without checking first).

Downgraded from hard blocker to first implementation step: before writing
anything downstream of it, fire one real `eth_getTransactionByHash` call
against `rpc.ankr.com/{chain}/{key}` with the real key. Fails fast, costs
one request, resolves this with certainty instead of docs-guessing. Flag
if you want me to run that smoke test myself once you're ready — it needs
`ANKR_API_KEY`, which I won't touch without you saying so.

## Test Cases

1. Successful (confirmed) transaction
2. Reverted transaction
3. Contract creation (`to = null`)
4. Pending transaction / no receipt yet
5. Nonexistent transaction hash
6. Malformed transaction hash
7. Wrong-chain hash (valid format, not found on the configured chain)
8. Unsupported chain (miner instance misconfigured/chain not covered)
9. RPC timeout / failure
10. Rate-limit / budget exhaustion
11. Recent / reorg-sensitive transaction (shallow confirmation depth)
12. Old transaction / RPC history limitations
13. Zero-value transaction
14. Contract call (non-transfer `input` data)
15. Transaction types 0, 1, and 2 (EIP-4844 where relevant to the chain)

## Explicitly Out of Scope for This Pass

- No further miner-selection research.
- Intent decision (ONCHAIN_TX_LOOKUP) not reopened.
- No `canonical` field unless a concrete on_chain mapping requirement
  surfaces later.
