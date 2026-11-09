// Small fetch helper shared by the field-telemetry routes (grid, validator,
// cloud, port, vessel, satellite). Fixed upstream hosts only, never a
// caller-supplied URL, so there is no SSRF surface.
export async function getJson(url, { timeoutMs = 8000, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'txlens-miner/1.0', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function upstreamDown(res, what, err) {
  return res.status(502).json({
    status: 'error',
    summary: `${what} is temporarily unavailable. Retry shortly.`,
    confidence: 0,
    error: String(err?.message ?? err),
  });
}

export function paramsOf(req) {
  return (req.method === 'GET' ? req.query : req.body) ?? {};
}
