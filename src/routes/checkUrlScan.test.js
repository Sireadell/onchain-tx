import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import urlScanRouter from './checkUrlScan.js';

// Reachability and TLS both do real network work (fetch + a real TLS
// handshake via lib/sslCheck.js, the same as checkSslVerification.test.js),
// so happy-path tests hit a real, stable public host rather than mocking
// fetch/tls wholesale. Only the web-reputation leg (lib/webSearch.js) is
// mockable, and is mocked below.

function startServer(t) {
  const app = express();
  app.use(express.json());
  app.use('/url-scan', urlScanRouter);
  const server = app.listen(0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function withoutAnyKey(t) {
  const prevT = process.env.TAVILY_API_KEY;
  const prevP = process.env.PERPLEXITY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (prevT !== undefined) process.env.TAVILY_API_KEY = prevT;
    if (prevP !== undefined) process.env.PERPLEXITY_API_KEY = prevP;
  });
}

function stubTavily(t, body) {
  const original = globalThis.fetch;
  const previous = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tvly-test-key';
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.tavily.com')) return original(url, init);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  });
}

test('url-scan: missing URL answered with guidance, not a 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});

test('url-scan: a reachable, clean, real domain is reported Safe', async (t) => {
  stubTavily(t, { answer: 'Clean. No reports of phishing or malware are documented for example.com.', results: [] });
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('https://example.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.reachable, true);
  assert.equal(body.verdict, 'Safe');
  assert.equal(body.tls.valid, true);
});

test('url-scan: a URL embedded in a whole question is extracted', async (t) => {
  stubTavily(t, { answer: 'Clean. No reports found.', results: [] });
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?query=${encodeURIComponent('Is https://example.com safe to visit?')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.query, 'https://example.com/');
});

test('url-scan: a bare domain with no scheme is treated as http', async (t) => {
  stubTavily(t, { answer: 'Clean. No reports found.', results: [] });
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('example.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
});

test('url-scan: a private/internal address is refused, not fetched', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /private or internal address/);
});

test('url-scan: localhost is refused, not fetched', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('http://localhost:8080/admin')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
});

test('url-scan: a nonexistent domain is reported unreachable rather than crashing', async (t) => {
  stubTavily(t, { answer: 'Clean. No reports found.', results: [] });
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('https://this-domain-should-not-exist-zzqx123.example')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.reachable, false);
  assert.notEqual(body.verdict, 'Safe');
});

test('url-scan: reputation search flagging phishing produces a Suspicious verdict', async (t) => {
  stubTavily(t, { answer: 'Flagged. This domain has been reported for phishing activity targeting bank customers.', results: [{ title: 'Phishing report', url: 'https://example.com/report', content: 'x' }] });
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('https://example.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.verdict, 'Suspicious');
  assert.equal(body.reputation_flagged, true);
});

// Real routed questions (epochs 360/361/363, replayed 2026-09-26): a plain
// "Suspicious" scored 0.00 on both of these while chainsight-oracle and
// proofgate-url-intelligence won the rounds, so the leading word now has to
// escalate to Malicious/Phishing when the URL structure itself is
// unambiguous (see the comment above classifyUrlStructure in
// checkUrlScan.js). withoutAnyKey is used because these two are decided by
// URL structure alone, not by reputation search or reachability.
test('url-scan: an executable download on a deceptive security-update domain is Malicious', async (t) => {
  withoutAnyKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('http://192.168.45.12.security-update-required.win/download/invoice.exe')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.verdict, 'Malicious');
  assert.match(body.summary, /^Malicious\./);
});

test('url-scan: a typosquatted PayPal login page on an abused TLD is Phishing', async (t) => {
  withoutAnyKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('http://paypa1-secure-login.verify-account.tk/signin')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.verdict, 'Phishing');
  assert.match(body.summary, /^Phishing\./);
});

// Epoch 362 replayed: same "google" brand mention as the phishing case
// above, but no lookalike-character substitution, no abused TLD, and no
// executable, so it must stay Suspicious (this is the wording that scored
// 0.99 live) rather than being swept into the new Phishing rule.
test('url-scan: a compound brand-mention domain with no lookalike characters stays Suspicious, not Phishing', async (t) => {
  withoutAnyKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('https://accounts-google-verify.com/oauth/confirm')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.notEqual(body.verdict, 'Phishing');
  assert.notEqual(body.verdict, 'Malicious');
});

test('url-scan: a benign, well-known domain is still Safe, not swept into the new rules', async (t) => {
  stubTavily(t, { answer: 'Clean. No reports of phishing or malware are documented for github.com.', results: [] });
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('https://github.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.verdict, 'Safe');
});

test('url-scan: not a valid URL at all is refused', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('not a url just words')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
});

test('url-scan: no search provider configured still answers using reachability/TLS alone', async (t) => {
  withoutAnyKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('https://example.com')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.reputation_flagged, null);
});

// Real routed question (2026-09-17 replay): "Check if github.com is a safe
// website" has no scheme anywhere in it, so it fell through to treating the
// entire sentence as the candidate URL and was refused as "not a valid
// URL", even though the sentence plainly names a real, scannable domain.
test('url-scan: a bare domain named inside a whole question is found and scanned', async (t) => {
  withoutAnyKey(t);
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('Check if github.com is a safe website')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.query, /github\.com/);
});

test('url-scan: a nonsense value with no dot anywhere is still refused, not mistaken for a domain', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan?url=${encodeURIComponent('Scan and judge this URL safe or unsafe: CVE-2021-44228')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'invalid_input');
});

test('url-scan: a 12000+ character input does not crash the route', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/url-scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `not a url ${'x'.repeat(12500)}` }),
  });
  assert.equal(res.status, 200);
});
