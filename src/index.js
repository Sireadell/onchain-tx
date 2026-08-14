import { buildApp } from './app.js';
import { getBlockNumber, withRpcBudget } from './lib/ankrRpc.js';

const PORT = Number(process.env.PORT) || 3000;
const CHAIN = process.env.CHAIN || 'eth';

// Fail fast on an unsupported/misconfigured CHAIN or a bad ANKR_API_KEY
// instead of deploying "successfully" and only discovering it per-request
// as an opaque 502 on the first real caller. A live eth_blockNumber call
// is a better check than a hardcoded chain allow-list — it validates the
// actual thing that matters (this key can reach this chain's endpoint
// right now) rather than a guessed, driftable list of chain names.
try {
  await withRpcBudget(() => getBlockNumber());
} catch (err) {
  console.error(`startup check failed: CHAIN=${CHAIN} is not reachable via Ankr — ${err.message}`);
  process.exit(1);
}

buildApp().listen(PORT, () => {
  console.log(`telegraph-onchain-tx-lookup-miner listening on :${PORT} (chain: ${CHAIN})`);
});
