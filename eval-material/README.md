# Evaluation data for four on-chain checks

Question-and-answer test cases for Anjoman, one file per Intent. Each row has a question (the prompt), a better answer (chosen), and a believable wrong answer (rejected). Some rows are "ground truth": a question and a correct answer only.

## Files

| File | Rows | Pairs | Ground truth | Chains |
|---|---|---|---|---|
| `CRYPTO_TRANSFER_VERIFY_GENERAL.jsonl` | 100 | 80 | 20 | 20 each on Ethereum, Base, Arbitrum, Optimism, Polygon |
| `TOKEN_TOTAL_SUPPLY_VERIFY_GENERAL.jsonl` | 100 | 80 | 20 | 20 each |
| `ONCHAIN_METRIC_VERIFY_GENERAL.jsonl` | 100 | 80 | 20 | 20 each |
| `CROSS_CHAIN_STATE_VERIFY_GENERAL.jsonl` | 117 | 92 | 25 | every row names Ethereum plus another chain (Optimism 43, Base 37, Polygon 21, Arbitrum 20) |
| `validate.py` | | | | checks the files against the upload format |
| `FEEDBACK.md` | | | | note for Ahmed |

Every question uses old, finished blocks and transactions, so the answers never change.

## How the numbers were checked

Every number came from reading the chain directly and was checked a second time.

- **Transfers (148):** status, fee, sender, recipient and block came from the transaction receipt. Fee is gas used times the price paid. Confirmations count the inclusion block as 1. Checked on a second public node.
- **Token supply (144):** total supply, burned balances and minted totals were read at fixed old blocks. Minted totals are the sum of mint events in a block range, and each was checked against the change in total supply over the same range. On Arbitrum there was no free second source for old data, so those rows rest on a re-check with a paid archive node plus the mint and burn consistency test.
- **On-chain values (87):** event amounts, gas used, contract token balances, contract coin balances and a stored implementation address, each read at a stated block. Event amounts and gas used were matched against a second node. Old balances were matched against a second node where one served old data. On Arbitrum they were not.
- **Cross-chain (113):** hashes and roots were recomputed by hand, not just copied. This covers Optimism-stack L1 origins, Arbitrum Outbox roots, Polygon checkpoint roots, Optimism dispute games, deposit links, and account proofs. The "does not verify" rows deliberately use a wrong hash, root, height or block range, and the question says so. Caveat: the 10 account-proof rows use blocks near the chain head at the time of writing, because old proofs are refused by every node. They are still fixed facts, but reproducing them later needs an archive node that serves proofs.

Free public nodes used: eth.drpc.org, ethereum-rpc.publicnode.com, mainnet.base.org, base.meowrpc.com, arbitrum-one-rpc.publicnode.com, arb1.arbitrum.io, optimism-rpc.publicnode.com, mainnet.optimism.io, polygon.drpc.org and polygon-bor-rpc.publicnode.com. A paid archive node was used for old state. No keys are stored in any file.

Wrong answers differ in every row and are within about 0.7 to 1.4 times the length of the right ones. Run the checker any time:

```bash
python3 eval-material/validate.py
```

## How to upload

1. Sign in at https://anjoman.ai/dashboard/eval with your own account.
2. Upload each `.jsonl` file as the Intent that matches its file name.
3. Check the status at `/api/evalpool/submissions/mine`. Rows can be rejected for near duplicates, repeated answers or a missing number.
4. If you upload with the signed command from the docs, send the file with `--data-binary` (not `-d`, which strips newlines), and use a fresh nonce each time.

Heads up: the network ignores an Intent's material until 5 different people have contributed to it.
