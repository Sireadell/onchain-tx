// Pulls the live public leaderboard + integrations feed and prints where
// txlens and telegraph-sentinel currently stand on every intent they're
// registered for. Read-only, no private key needed — safe to run anytime.
//
// Usage: node scripts/check-standing.js

const SLUGS = ['txlens', 'telegraph-sentinel'];

const [leaderboardRes, integrationsRes] = await Promise.all([
  fetch('https://explorer.telegraphprotocol.com/api/leaderboard/miners'),
  fetch('https://explorer.telegraphprotocol.com/api/integrations'),
]);
const leaderboard = await leaderboardRes.json();
const integrations = await integrationsRes.json();
const intFeed = Array.isArray(integrations) ? integrations : (integrations.miners ?? integrations.data ?? []);

console.log(`epoch ${leaderboard.epoch}\n`);

for (const slug of SLUGS) {
  const info = intFeed.find((m) => m.slug === slug);
  console.log(`=== ${slug} ===`);
  if (!info) {
    console.log('  not yet visible in the miner directory (pending ingestion or deregistered)\n');
    continue;
  }
  console.log(`  status: ${info.activation_status} | id: ${info.id} | requests served: ${info.total_requests_served ?? 0}`);

  const rows = [];
  for (const [intent, entries] of Object.entries(leaderboard.intents)) {
    const mine = entries.find((e) => e.miner_slug === slug);
    if (mine) rows.push({ intent, ...mine, field_size: entries.length });
  }
  if (rows.length === 0) {
    console.log('  no leaderboard entries yet for any intent\n');
    continue;
  }
  for (const r of rows) {
    console.log(`  ${r.intent.padEnd(22)} rank ${r.rank}/${r.field_size}  score ${r.score}`);
  }
  console.log('');
}
