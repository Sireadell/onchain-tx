# TxLens ONCHAIN_TX_LOOKUP Scorer Handoff

**Handoff date:** 2026-08-25  
**Repository:** `C:\Users\DELL\telegraph-onchain-tx-lookup`  
**Branch at handoff:** `main`, three commits ahead of `origin/main`  
**Public submission status:** Do not submit yet. The address, transaction-ID, and amount comparisons stopped because champion #642 exceeded the three-minute timeout during emoji preflight. The block comparison was deliberately paused for this handoff, and the status comparison never started. Results remain indeterminate.

## Objective

Build an ONCHAIN_TX_LOOKUP scoring module that reliably gives a higher score to a factually correct transaction answer than to a nearly identical answer with one critical false fact. The immediate goal is to beat the live champion's good-versus-bad margin without sacrificing correct ordering.

The miner and scorer are separate competitions. Faster Ankr responses may help the TxLens miner, but they do not improve this scoring module's leaderboard result. This handoff concerns the scorer.

## Non-negotiable safety rules

1. Never register a scorer without the user's explicit confirmation for that exact registration.
2. Never run `scripts/register-scoring-module.js` in its current state.
3. Before registration, upload the exact final local `.wasm` file, download it again from the exact proposed public URL, and prove that its byte count and both SHA-256 and Keccak-256 hashes match the local file.
4. The registration contract uses the Keccak-256 hash. The SHA-256 hash is also recorded for reproducibility.
5. Do not report a pending comparison as passed, failed, or completed.
6. Every public evaluator update to the user must include ordering, our margin, champion margin, gap, comparable case count, rejection reason, and whether the result progressed or regressed.

## Public scorer history

The evaluator's margin is the average score advantage of the correct answer over the bad answer. A larger positive margin means the scorer separates truth from a subtle false answer more strongly.

| Registration | Result | Ordering | Our margin | Champion margin | Gap behind champion | Reason |
|---|---|---:|---:|---:|---:|---|
| #616 | Rejected | 14/15 | 0.43816555 | 0.59666926 | 0.15850371 | Ordering failed on one case |
| #704 | Rejected | 9/9 | 0.61613300 | 0.66052693 | 0.04439393 | Ordering passed, separation was too weak |
| #708 | Rejected | 11/11 | 0.58113830 | 0.71983415 | 0.13869585 | Ordering passed, separation was too weak |

Use #708 as the latest public baseline. It had perfect ordering on all 11 comparable cases but separated correct and bad answers by 0.13869585 less than the champion. Compared with #704, #708 regressed by 0.03499470 in our margin and its gap behind the champion widened by 0.09430192. Do not hide that regression when reporting progress.

#708 registration transaction:

`0xe242b42d4e5f8a49c520f6722b2dfddb211af060a6c2b014e3d8c0cc26c29cc6`

## Current champion

- Registration: **#642**
- Intent: `ONCHAIN_TX_LOOKUP`
- Known overall public score observed during this work: **0.7922707**
- Champion margin used by the #708 evaluator comparison: **0.71983415**
- Public binary URL:
  `https://raw.githubusercontent.com/zkasuran/telegraph-salience-scorer/92167ea85229156e2e761afa36a6b50fcc9fedfa/dist/xfmr/otx_t74.wasm`
- Binary size: **23,989,222 bytes**
- SHA-256 of both local champion copies:
  `a53e88df1b2413a8e5378462772c0e80b49892fd273ea31f50c560a04424d2e3`
- The binary has zero imported functions and exports memory, `alloc`, `dealloc`, `rank_answer`, and `TELEGRAPH_INTENT`.
- Only the compiled binary is available here. Do not claim its exact internal algorithm.

The champion's overall public score and its margin in a particular evaluator run are different measurements. Do not treat 0.7922707 and 0.71983415 as interchangeable.

## Exact working tree at handoff

Tracked files modified locally:

- `scoring-module/fixtures.json`
- `scoring-module/src/lib.rs`
- `scoring-module/tester/main.go`
- `scripts/register-scoring-module.js`

Untracked files:

- `scoring-module/comparator/artifacts/champion-642.wasm`
- `scoring-module/comparator/champion-probe.json`
- `scoring-module/comparator/downloads/champion-642.wasm`
- `scoring-module/comparator/go.mod`
- `scoring-module/comparator/go.sum`
- `scoring-module/comparator/main.go`
- `scoring-module/comparator/main_test.go`

This handoff file is also new after the status snapshot above. Existing changes belong to the user. Do not reset, discard, or overwrite them.

The two champion binaries are identical duplicate files, each **23,989,222 bytes**, almost 48 MB combined. They are untracked and not ignored. Do not accidentally commit them. Keep one intentional local artifact or add a narrow ignore rule only after reviewing how the comparator should be packaged.

## Current local scorer binary

Path:

`scoring-module/target/wasm32-unknown-unknown/release/txlens_onchain_tx_lookup_scorer.wasm`

- Size: **24,188,821 bytes**
- Imported functions: **0**
- SHA-256: `7c3e8b7efe119a8ae5fdafdb791d295118185c2cb92839e507aeb85b0f7fecfc`
- Keccak-256: `0xb4c1dc24ac6262b9d2fd1f1a8663292e7eae3e132416ba4a02ce195a3e7c2b89`

Rebuilds can change these values. Recompute them after every source change and before any upload or registration.

## Scorer changes made locally

The base scorer embeds MiniLM-L6-v2 for semantic similarity and combines it with exact transaction facts, status handling, word overlap, unsupported-fact penalties, and sender/recipient role checks.

The current uncommitted work adds or changes the following:

1. **Fabricated full address or transaction ID ceiling.** An allocation-free byte scanner searches the complete raw answer, including prose and compact JSON, for exact `0x` plus 40 hexadecimal-character wallet addresses or `0x` plus 64 hexadecimal-character transaction IDs. If a full identifier is not present in the question or truth, case-insensitively, the final score is capped at **0.40**.
2. **No arbitrary word limit.** The scanner covers identifiers after more than 200 words.
3. **Embedded-token bypass fixed.** A fake identifier in text such as `ref0x...` is still detected.
4. **Right-edge safety.** A 40-hex run followed by `_debug` is treated as part of a larger token and does not trigger the ceiling.
5. **Near-miss lengths are not capped.** A 41-character address or 65-character transaction ID is not treated as a valid full identifier.
6. **Question facts are trusted.** Repeating the transaction ID from the question is allowed, including uppercase text and compact JSON.
7. **Numeric hard ceilings were deliberately rejected.** Numbers such as amounts, blocks, and confirmation counts require role-aware interpretation. A broad number ceiling caused false positives, including comma and decimal-format problems.
8. **Sender/recipient reversal penalty increased** from 0.45 to 0.65.
9. **Self-transfers are exempted from sender/recipient reversal detection** because the same address legitimately has both roles.
10. **Tester improvements.** `ONLY_CASES` selects named checks, and optional `min_good_score` and `max_bad_score` fields enforce meaningful limits.

## Focused local test evidence

These are local checks, not leaderboard results.

| Check | Correct score | Bad score | Required result | Outcome |
|---|---:|---:|---|---|
| 12 confirmations versus fake block | 0.8096 | 0.2989 | Correct at least 0.80 | Passed |
| Query transaction ID inside compact JSON | 0.7837 | 0.0000 | Correct at least 0.41 | Passed |
| Fake full address inside raw JSON | 0.9401 | 0.0000 | Bad at most 0.40 | Passed |
| Normal prose plus fake address in JSON fragment | 0.8997 | 0.4000 | Bad at most 0.40 | Passed |
| Fake full transaction ID | 0.9368 | 0.4000 | Bad at most 0.40 | Passed |
| Fake address after 200 words | 0.9392 | 0.4000 | Bad at most 0.40 | Passed |
| Malformed 41-character address | 0.8091 | 0.0000 | Correct at least 0.41 | Passed |
| Malformed 65-character transaction ID | 0.6831 | 0.0000 | Correct at least 0.41 | Passed |
| Uppercase address matching lowercase truth | 0.9380 | 0.0000 | Correct at least 0.41 | Passed |
| Fake address glued after a letter | 0.8997 | 0.4000 | Bad at most 0.40 | Passed |
| Fake transaction ID glued after a digit | 0.8998 | 0.4000 | Bad at most 0.40 | Passed |
| Valid-length hex run followed by `_debug` | 0.8913 | 0.0000 | Correct at least 0.41 | Passed |

Important limitation: fake amount, wrong block, and wrong status behavior still need controlled head-to-head measurements against champion #642. The scorer does not currently have a numeric hard ceiling.

## Comparator

Location: `scoring-module/comparator`

The comparator runs one named controlled case against the local scorer and champion. Each model calculation can take roughly one to two minutes. Earlier 30-second command limits killed runs and made the tool look frozen. The comparator was repaired to print progress and elapsed time, apply explicit calculation and load deadlines, and identify the failed case, scorer, and stage.

Further repairs now provide:

- Local preflight enabled by default.
- Explicit diagnostic-only opt-out: `-diagnostic-skip-preflight`.
- Clear wording that this is local preflight plus one selected case, not the evaluator's complete multi-case history.
- Absolute paths and SHA-256 hashes for both scorer files and the probe file.
- Seven-decimal scores and margins.
- Optional machine-readable JSON through `-json-out`.
- Required-field and duplicate-case validation.
- Rejection of NaN, infinity, and scores outside 0 to 1.
- Protection against choosing either scorer, the probe, or an existing file as JSON output.
- Temporary-file then rename behavior for JSON output.
- Calculation and model-loading timeouts.

Verification completed before this handoff:

- `gofmt` clean
- `go test -count=1 -v ./...` passed
- `go vet ./...` passed
- `go build ./...` passed

Known comparator limitation: the output-file existence check followed by rename has a small cross-process race on systems where rename can replace an existing destination. This does not block supervised local diagnosis, but do not aim `-json-out` at valuable files. File reading and hashing occur before the model-load timeout, so a blocked filesystem read is not bounded by that timeout.

Current comparator file hashes:

| File | SHA-256 |
|---|---|
| `main.go` | `3610d041a90fb85e6d0b1c858cbde217d1cf96607e60723fdd1815554fc29b25` |
| `main_test.go` | `71f07bce3e157de8af90d9914ee9aa969c7b85c7648266650538e2dfe0282eda` |
| `champion-probe.json` | `84626f9874a37d213febac350e29bb38d8bcbef47f0a0fecc3a59875ab1a51ee` |
| `go.mod` | `1c1a3559f53aa1826447967b66324e549ca0616d0fe5ef8be21d49d5fac9a322` |
| `go.sum` | `cea54d921525fe5bc10db3146d1e25ef004400a3c2386acae505c4b582c0255f` |

An earlier smoke comparison used an older flawed probe and omitted the now-default preflight. It showed TxLens margin 0.4764 and champion margin about 0.0001 on a fabricated-address answer, but it must not be used as submission evidence.

## Five approved controlled probe cases

The probe file has been independently reviewed. Each correct answer is supported by its truth, and each bad answer changes exactly one intended fact.

1. `controlled-invented-full-address`
2. `controlled-invented-full-transaction-hash`
3. `controlled-fabricated-amount-only`
4. `controlled-wrong-block-number-only`
5. `controlled-wrong-transaction-status-only`

## Final comparison outcomes at handoff

Results remain **indeterminate**. Do not report any of these attempts as a TxLens win or loss.

| Case | Final outcome |
|---|---|
| Invented full address | Stopped because champion #642 exceeded the three-minute timeout during emoji preflight. No selected-case scores or margins were produced. |
| Invented full transaction ID | Stopped because champion #642 exceeded the three-minute timeout during emoji preflight. No selected-case scores or margins were produced. |
| Fabricated amount only | Stopped because champion #642 exceeded the three-minute timeout during emoji preflight. No selected-case scores or margins were produced. |
| Wrong block number only | Deliberately paused for this handoff. It did not complete. |
| Wrong transaction status only | Never started. |

Exact files used by the three attempted comparisons:

- TxLens SHA-256: `7c3e8b7efe119a8ae5fdafdb791d295118185c2cb92839e507aeb85b0f7fecfc`
- Champion #642 SHA-256: `a53e88df1b2413a8e5378462772c0e80b49892fd273ea31f50c560a04424d2e3`
- Probe SHA-256: `84626f9874a37d213febac350e29bb38d8bcbef47f0a0fecc3a59875ab1a51ee`

Partial TxLens preflight scores recorded before the champion timeout:

| Preflight check | TxLens score |
|---|---:|
| Empty | 0.0000000 |
| Blank | 0.0000000 |
| Emoji | 0.1240570 |
| Long answer | 0.3016909 |

No selected-case correct score, bad score, or margin is available from these attempts. The next comparison must use a timeout longer than three minutes. Use **10 minutes** unless new timing evidence supports another limit.

## Registration-script mismatch, critical warning

`scripts/register-scoring-module.js` currently points at this old Pinata URL:

`https://gateway.pinata.cloud/ipfs/QmVreKHsBDcUMtQLgfoCPbtUiWbw6wTAj3YbE63zETyHB7`

Live fetch on 2026-08-25 proved that URL serves:

- Size: **24,188,166 bytes**
- SHA-256: `2972a13b82000be5c8117136f55095324812f5a9a19eaa1dbb26ccaf204812b1`
- Keccak-256: `0x8ae512fa90fa57bb9285c2956447509b63eff06a65fee7505e08b55b671daa8e`

The current local scorer is **24,188,821 bytes** with SHA-256 `7c3e8b...fecfc` and Keccak-256 `0xb4c1...c2b89`. The URL and local file therefore do not match.

The script hashes the current local file but submits the fixed old URL. Running it now would publicly register a broken hash-and-URL pairing. IPFS content is immutable, so the old CID cannot be updated to contain the new bytes.

## Exact next steps

1. Rerun the address, transaction-ID, and amount comparisons with a **10-minute calculation timeout** because the three-minute limit stopped champion #642 during emoji preflight.
2. Confirm each result uses:
   - local scorer SHA-256 `7c3e8b7efe119a8ae5fdafdb791d295118185c2cb92839e507aeb85b0f7fecfc`
   - champion SHA-256 `a53e88df1b2413a8e5378462772c0e80b49892fd273ea31f50c560a04424d2e3`
   - probe SHA-256 `84626f9874a37d213febac350e29bb38d8bcbef47f0a0fecc3a59875ab1a51ee`
   - default preflight, not the diagnostic skip flag
3. Run the deliberately paused block case and then the status case, which never started, using the same 10-minute timeout.
4. Put the five exact results in one table. For each scorer show correct score, bad score, and margin. Also show the average margin across all five cases.
5. Diagnose weak cases. Address and transaction-ID falsehoods should be at or below 0.40 locally. Amount, block, and status are the unresolved decision points. Do not add a broad number ceiling. Any number logic must understand whether a number is an amount, block, confirmation count, or other supporting detail.
6. If scorer logic changes, rebuild, rerun focused tests, rerun all five controlled comparisons, and recompute all hashes.
7. Only after local evidence is strong enough, prepare a new upload. Do not upload or register merely because correct answers beat bad answers. The latest public target to exceed is the champion margin **0.71983415**, while preserving perfect ordering.
8. If the user explicitly approves a new registration, upload the exact final binary, verify the downloaded bytes and hashes, update `WASM_URL` to the new immutable CID, verify the script computes the matching Keccak-256, use a read-only/static contract call first, show the user the exact URL and hashes, and then register.
9. After registration, poll the live evaluator. Report full stats, not only accepted or rejected.

## Safe local commands

Run from `C:\Users\DELL\telegraph-onchain-tx-lookup`.

Build the scorer:

```powershell
Set-Location 'C:\Users\DELL\telegraph-onchain-tx-lookup\scoring-module'
cargo build --release --target wasm32-unknown-unknown
```

Compute local hashes without changing files:

```powershell
Set-Location 'C:\Users\DELL\telegraph-onchain-tx-lookup'
Get-FileHash -Algorithm SHA256 'scoring-module\target\wasm32-unknown-unknown\release\txlens_onchain_tx_lookup_scorer.wasm'
node --input-type=module -e "import {readFileSync} from 'fs'; import {ethers} from 'ethers'; const b=readFileSync('scoring-module/target/wasm32-unknown-unknown/release/txlens_onchain_tx_lookup_scorer.wasm'); console.log(b.length, ethers.keccak256(b));"
```

Run selected focused scorer checks:

```powershell
Set-Location 'C:\Users\DELL\telegraph-onchain-tx-lookup\scoring-module\tester'
$env:ONLY_CASES='prose-with-fake-full-address-in-json-fragment,fake-full-transaction-hash,fake-address-glued-after-letter-is-capped,fake-hash-glued-after-digit-is-capped'
go run . '..\target\wasm32-unknown-unknown\release\txlens_onchain_tx_lookup_scorer.wasm' '..\fixtures.json'
Remove-Item Env:ONLY_CASES
```

Verify the comparator without running a model comparison:

```powershell
Set-Location 'C:\Users\DELL\telegraph-onchain-tx-lookup\scoring-module\comparator'
gofmt -d .
go test -count=1 -v ./...
go vet ./...
go build ./...
```

Run one approved comparison with default preflight. Use a new JSON filename because existing outputs are intentionally refused:

```powershell
Set-Location 'C:\Users\DELL\telegraph-onchain-tx-lookup\scoring-module\comparator'
go run . -case controlled-wrong-block-number-only -timeout 10m -load-timeout 10m -json-out block-result.json '..\target\wasm32-unknown-unknown\release\txlens_onchain_tx_lookup_scorer.wasm' '.\artifacts\champion-642.wasm' '.\champion-probe.json'
```

Then run `controlled-wrong-transaction-status-only` with a different JSON output filename.

Do **not** run either command below until the user explicitly approves registration and the URL/hash pairing has been independently verified:

```powershell
node --env-file=.env scripts\pin-scoring-wasm.js
node --env-file=.env scripts\register-scoring-module.js
```

The first command uploads externally. The second broadcasts a public on-chain registration. Neither is part of ordinary local testing.

## Relevant project documents and lessons

- `BUILD_SPEC.md` describes the five-chain TxLens miner and clarifies that ONCHAIN_TX_LOOKUP is a shared intent with varied answer formats. The scorer must not assume only TxLens's own vocabulary or response format.
- Repository `LEARNINGS.md` points to `C:\Users\DELL\.claude\LEARNINGS.md`.
- The global learning log says to verify live registration state through the specific Telegraph registration API, not only the aggregate list. It also records that Pinata's shared public gateway has been unreliable for this account. Prefer the dedicated gateway and always fetch the exact uploaded file before registration.
- The log also warns that registration and activation can take several minutes. Poll the specific registration for three to five minutes before concluding it is stuck.
- Never expose `MINER_PRIVATE_KEY` or the Pinata token in commands or output.

## Final decision state

The local scorer is materially better at rejecting fabricated full addresses and transaction IDs, and focused checks pass. It is not yet proven ready for another public submission. Three approved comparisons stopped during champion #642's emoji preflight because the three-minute timeout was too short, the block run was deliberately paused for this handoff, and the status run never started. No selected-case scores or margins were produced, so the comparison result remains indeterminate. The current public gap remains **0.13869585** behind the champion on #708. Rerun all five comparisons with a recommended 10-minute timeout before deciding whether to change scorer logic, upload, or ask the user to approve registration.
