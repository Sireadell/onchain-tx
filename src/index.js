import { buildApp } from './app.js';
import { getBlockNumber, withRpcBudget } from './lib/ankrRpc.js';
import { CHAINS } from './lib/chains.js';

const PORT = Number(process.env.PORT) || 3000;

// One process serves all 14 intents, so an unhandled rejection anywhere
// takes every intent down until Render cold-starts a replacement. Node 22
// exits on one by default. Log it and keep serving instead: a single broken
// request is not a reason to drop the other thirteen intents.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection (kept serving):', reason);
});

// Probe every allowlisted chain at startup with a live eth_blockNumber call
// instead of deploying "successfully" and only discovering a bad chain or
// API key per-request as an opaque 502 on the first real caller. Only exit
// if EVERY chain is unreachable (a genuinely broken deployment, e.g. a bad
// ANKR_API_KEY) — a single chain being unreachable (e.g. a key not yet
// plan-enabled for it) shouldn't take down the other four; that chain will
// just keep 502ing per-request until it's fixed, same as any other
// transient upstream failure.
const results = await Promise.all(
  Object.entries(CHAINS).map(async ([slug, { segment }]) => {
    try {
      await withRpcBudget(() => getBlockNumber(segment));
      return { slug, ok: true };
    } catch (err) {
      return { slug, ok: false, message: err.message };
    }
  })
);

for (const r of results) {
  if (r.ok) {
    console.log(`startup check: ${r.slug} reachable via Ankr`);
  } else {
    console.error(`startup check: ${r.slug} NOT reachable via Ankr — ${r.message}`);
  }
}

if (results.every((r) => !r.ok)) {
  console.error('startup check failed: no configured chain is reachable via Ankr — refusing to start');
  process.exit(1);
}

buildApp().listen(PORT, () => {
  const okChains = results.filter((r) => r.ok).map((r) => r.slug);
  console.log(`telegraph-onchain-tx-lookup-miner listening on :${PORT} (chains: ${okChains.join(', ')})`);
});
