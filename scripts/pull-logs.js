// Pulls this miner's Render logs over the API instead of the dashboard, so the
// misroute watch can be read without a browser login. Read-only: it never
// writes to Render, and it only ever sends the key to api.render.com.
//
// Usage: node --env-file-if-exists=.env scripts/pull-logs.js [options]
//
//   --text=misroute-watch   substring filter, repeatable (default: misroute)
//   --all                   no text filter, every log line
//   --hours=24              how far back to look (default: 24)
//   --limit=100             max lines (default: 100)
//
// Needs RENDER_API_KEY in .env. Make one at:
//   https://dashboard.render.com/u/settings#api-keys

const SERVICE_NAME = 'telegraph-onchain-tx-lookup-miner';
const API = 'https://api.render.com/v1';

const key = process.env.RENDER_API_KEY;
if (!key) {
  console.error('RENDER_API_KEY is missing. Add it to .env (it is gitignored), then rerun.');
  console.error('Create one at https://dashboard.render.com/u/settings#api-keys');
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const texts = args.filter((a) => a.startsWith('--text=')).map((a) => a.slice(7));
const noFilter = args.includes('--all');
const hours = Number(flag('hours', '24'));
const limit = Number(flag('limit', '100'));

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}\n${body.slice(0, 400)}`);
  }
  return res.json();
}

const owners = await api('/owners?limit=20');
const ownerId = owners[0]?.owner?.id;
if (!ownerId) throw new Error('No owner found on this API key.');

const services = await api(`/services?limit=50&name=${encodeURIComponent(SERVICE_NAME)}`);
const service = services.find((s) => s.service?.name === SERVICE_NAME)?.service;
if (!service) {
  console.error(`Service "${SERVICE_NAME}" not visible to this key. Services it can see:`);
  for (const s of services) console.error(`  ${s.service?.name}`);
  process.exit(1);
}

const startTime = new Date(Date.now() - hours * 3600 * 1000).toISOString();
const params = new URLSearchParams({ ownerId, limit: String(limit), startTime });
params.append('resource', service.id);
if (!noFilter) for (const t of (texts.length ? texts : ['misroute'])) params.append('text', t);

const out = await api(`/logs?${params}`);
const lines = out.logs ?? [];

console.log(`service ${service.name} (${service.id})`);
console.log(`window  last ${hours}h since ${startTime}`);
console.log(`filter  ${noFilter ? '(none)' : (texts.length ? texts : ['misroute']).join(', ')}`);
console.log(`lines   ${lines.length}${out.hasMore ? ' (more available)' : ''}\n`);

if (lines.length === 0) {
  console.log('No matching log lines. Either nothing was logged, or it aged out of');
  console.log('Render retention. Try --all --limit=50 to confirm logging works at all.');
}
for (const l of lines.reverse()) console.log(`${l.timestamp} ${l.message}`);
