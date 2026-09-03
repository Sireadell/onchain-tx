import express from 'express';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { freeTextParam } from '../lib/entityExtract.js';

const router = express.Router();
const DEFAULT_SENTINEL_BASE_URL = 'https://telegraph-sentinel-40vp.onrender.com';
// Telegraph's confirmed synchronous Miner timeout is 30s (docs/PROTOCOL_NOTES.md
// in telegraph-sentinel). Sentinel's own internal hard cutoff is 20-25s
// (docs/LOCKED_SPEC.md there), with p90 latency at 15s. 12s was cutting off
// genuine slower-but-valid Sentinel answers before Sentinel itself gave up,
// turning them into empty "inconclusive" responses. 27s gives Sentinel its
// full internal budget while still returning before Telegraph's 30s cutoff.
const DEFAULT_TIMEOUT_MS = 27_000;

function sentinelBaseUrl() {
  return (process.env.SENTINEL_BASE_URL || DEFAULT_SENTINEL_BASE_URL).replace(/\/$/, '');
}

function timeoutMs() {
  const configured = Number(process.env.SENTINEL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function respondSentinelUnavailable(res, detail) {
  return res.json({
    status: 'inconclusive',
    assessment_status: 'INCONCLUSIVE',
    summary: `The fraud assessment is inconclusive because Sentinel is temporarily unavailable${detail ? `: ${detail}` : ''}. Retry shortly.`,
    confidence: 0,
  });
}

async function proxySentinel(req, res, path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const target = new URL(`${sentinelBaseUrl()}${path}`);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (typeof value === 'string') target.searchParams.set(key, value);
    }

    // Sentinel only accepts its free-text field under the literal key
    // `query`. Callers routinely send the same text under `question`, `q`,
    // `text`, `input`, or `prompt` instead — every one of those already
    // counts for our own free-text extraction (see entityExtract.js) — but
    // forwarding req.body unchanged threw that text away, so Sentinel saw
    // no `query` and rejected a perfectly good question as unusable input.
    const outgoingBody = { ...(req.body ?? {}) };
    if (req.method === 'POST' && typeof outgoingBody.query !== 'string') {
      const text = freeTextParam(outgoingBody);
      if (text) outgoingBody.query = text;
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers: req.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: req.method === 'POST' ? JSON.stringify(outgoingBody) : undefined,
      signal: controller.signal,
    });

    const raw = await upstream.text();
    if (!raw) {
      if (upstream.status === 400 || upstream.status === 422) {
        return respondUnusableInput(
          res,
          'I cannot assess this wallet for fraud risk because Sentinel rejected the input. Pass a wallet address, 42 characters long and starting with "0x", as the wallet parameter, and I will return a risk verdict with the reasons behind it.',
        );
      }
      return respondSentinelUnavailable(res, `Sentinel returned an empty response (status ${upstream.status})`);
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      if (upstream.status === 400 || upstream.status === 422) {
        return respondUnusableInput(
          res,
          'I cannot assess this wallet for fraud risk because Sentinel rejected the input. Pass a wallet address, 42 characters long and starting with "0x", as the wallet parameter, and I will return a risk verdict with the reasons behind it.',
        );
      }
      if (upstream.status === 429 || upstream.status >= 500) {
        return respondSentinelUnavailable(res, `Sentinel returned a non-JSON response (status ${upstream.status})`);
      }
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

    if (!upstream.ok) {
      const detail = body?.summary ?? body?.error ?? body?.message ?? `status ${upstream.status}`;
      return respondSentinelUnavailable(res, detail);
    }

    return res.status(upstream.status).json({
      ...body,
      status: body.status ?? body.label,
      summary: body.summary ?? body.reason,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return respondSentinelUnavailable(res, `request timed out after ${timeoutMs()}ms`);
    }
    console.error(`Sentinel proxy failed for ${path}:`, error);
    return respondSentinelUnavailable(res, error.message);
  } finally {
    clearTimeout(timeout);
  }
}

// Exposed so the misroute handoff can answer a fraud question that the
// dispatcher sent to another one of our endpoints, without an HTTP call back
// into this service. Takes the same synthetic request shape the other
// handoff targets take: { method, query, body }.
export function handleFraudAssessment(req, res) {
  return proxySentinel(req, res, '/assess-wallet');
}

router.post('/fraud-query', (req, res) => proxySentinel(req, res, '/fraud-query'));
router.get('/assess-wallet', (req, res) => proxySentinel(req, res, '/assess-wallet'));
router.post('/assess-wallet', (req, res) => proxySentinel(req, res, '/assess-wallet'));

export default router;
