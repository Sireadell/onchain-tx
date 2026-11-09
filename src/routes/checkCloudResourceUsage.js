// CLOUD_RESOURCE_USAGE: compute, memory and network utilisation read from a
// live Prometheus server (the public PromLabs demo, which scrapes a real
// node_exporter). Only this fixed server is queried, never a caller URL.
// The question may name one metric (cpu, memory, network); with none named
// all three are returned.

import { Router } from 'express';
import { firstUsableValue, freeTextParam } from '../lib/entityExtract.js';
import { getJson, upstreamDown, paramsOf } from '../lib/liveJson.js';

const router = Router();
const PROM = 'https://demo.promlabs.com/api/v1/query';

export const QUERIES = {
  cpu: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
  memory: '100 * (1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes))',
  network_rx: 'sum(rate(node_network_receive_bytes_total{device!="lo"}[5m]))',
  network_tx: 'sum(rate(node_network_transmit_bytes_total{device!="lo"}[5m]))',
};

export function wantedMetrics(value, text) {
  const hay = `${value ?? ''} ${text ?? ''}`.toLowerCase();
  const out = new Set();
  if (/cpu|compute|processor/.test(hay)) out.add('cpu');
  if (/mem|ram/.test(hay)) out.add('memory');
  if (/network|throughput|bandwidth|traffic/.test(hay)) { out.add('network_rx'); out.add('network_tx'); }
  return out.size ? out : new Set(Object.keys(QUERIES));
}

async function scalar(query) {
  const j = await getJson(`${PROM}?query=${encodeURIComponent(query)}`);
  const v = Number(j?.data?.result?.[0]?.value?.[1]);
  return Number.isFinite(v) ? v : null;
}

async function handle(req, res) {
  const params = paramsOf(req);
  const want = wantedMetrics(firstUsableValue(params.metric, params.resource), freeTextParam(params));
  const out = {};
  try {
    await Promise.all([...want].map(async (k) => { out[k] = await scalar(QUERIES[k]); }));
  } catch (err) {
    return upstreamDown(res, 'The cloud telemetry source', err);
  }
  const parts = [];
  if (out.cpu != null) parts.push(`CPU utilisation ${out.cpu.toFixed(1)}%`);
  if (out.memory != null) parts.push(`memory pressure ${out.memory.toFixed(1)}% used`);
  if (out.network_rx != null) parts.push(`network receive ${(out.network_rx / 1024).toFixed(1)} KiB/s`);
  if (out.network_tx != null) parts.push(`network transmit ${(out.network_tx / 1024).toFixed(1)} KiB/s`);
  if (!parts.length) return upstreamDown(res, 'The cloud telemetry source (no samples)', 'empty result');
  res.json({
    status: 'ok',
    summary: `Live host metrics from Prometheus (5 minute window): ${parts.join(', ')}.`,
    confidence: 0.85,
    canonical: `cloud-resource-usage:${[...want].sort().join(',')}`,
    cpu_percent: out.cpu != null ? Number(out.cpu.toFixed(2)) : undefined,
    memory_used_percent: out.memory != null ? Number(out.memory.toFixed(2)) : undefined,
    network_receive_bytes_per_sec: out.network_rx != null ? Math.round(out.network_rx) : undefined,
    network_transmit_bytes_per_sec: out.network_tx != null ? Math.round(out.network_tx) : undefined,
    source: 'Prometheus (demo.promlabs.com node_exporter)',
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handle(req, res));
router.post('/', (req, res) => handle(req, res));
export default router;
