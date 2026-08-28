import express from 'express';
import { respondUnusableInput } from '../lib/unusableInput.js';

const router = express.Router();
const DEFAULT_SENTINEL_BASE_URL = 'https://telegraph-sentinel-40vp.onrender.com';
const DEFAULT_TIMEOUT_MS = 55_000;

function sentinelBaseUrl() {
  return (process.env.SENTINEL_BASE_URL || DEFAULT_SENTINEL_BASE_URL).replace(/\/$/, '');
}

function timeoutMs() {
  const configured = Number(process.env.SENTINEL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

async function proxySentinel(req, res, path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const target = new URL(`${sentinelBaseUrl()}${path}`);
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') target.searchParams.set(key, value);
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers: req.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined,
      signal: controller.signal,
    });

    const raw = await upstream.text();
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return res.status(502).json({ error: 'Sentinel returned an invalid response' });
    }

    // A 400 or 422 from Sentinel means the caller's input was unusable, not
    // that anything is broken, and Telegraph books any non-2xx as a failed
    // question. Answer those instead of passing the failure through. See
    // ../lib/unusableInput.js. Genuine faults keep their own status.
    if (upstream.status === 400 || upstream.status === 422) {
      const detail = body?.summary ?? body?.error ?? body?.message ?? null;
      const cause = detail ? `: ${detail}` : ' because no wallet address was supplied';
      return respondUnusableInput(
        res,
        `I cannot assess this wallet for fraud risk${cause}. Pass a wallet address, 42 characters long and starting with "0x", as the wallet parameter, and I will return a risk verdict with the reasons behind it.`,
      );
    }

    if (!upstream.ok) return res.status(upstream.status).json(body);

    return res.status(upstream.status).json({
      ...body,
      status: body.status ?? body.label,
      summary: body.summary ?? body.reason,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return res.status(504).json({ error: 'Sentinel request timed out' });
    }
    console.error(`Sentinel proxy failed for ${path}:`, error);
    return res.status(502).json({ error: 'Sentinel is temporarily unavailable' });
  } finally {
    clearTimeout(timeout);
  }
}

router.post('/fraud-query', (req, res) => proxySentinel(req, res, '/fraud-query'));
router.get('/assess-wallet', (req, res) => proxySentinel(req, res, '/assess-wallet'));
router.post('/assess-wallet', (req, res) => proxySentinel(req, res, '/assess-wallet'));

export default router;
