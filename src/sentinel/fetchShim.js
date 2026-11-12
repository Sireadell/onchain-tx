// Test helper: routes the engine call through global fetch so tests can keep
// stubbing the answer the engine would give.
import { engine } from '../routes/sentinelFraud.js';

engine.run = async (path, method, target, body, signal) => {
  const response = await fetch(new URL(`https://telegraph-sentinel-40vp.onrender.com${path}${target.search}`), {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    signal,
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
};
