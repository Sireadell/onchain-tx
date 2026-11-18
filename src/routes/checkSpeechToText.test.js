import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { audioUrlFromText } from '../lib/speechAudio.js';

function startServer(t) {
  const server = buildApp().listen(0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return original(url, init);
    return handler(String(url), init);
  };
  t.after(() => { globalThis.fetch = original; });
}

test('stt: audio link is found in a sentence and trailing punctuation is dropped', () => {
  assert.equal(audioUrlFromText('Transcribe https://example.com/interview.mp3.'), 'https://example.com/interview.mp3');
  assert.equal(audioUrlFromText('no link here'), null);
});

test('stt: no audio link answers with what is needed', async (t) => {
  const base = startServer(t);
  const body = await (await fetch(`${base}/transcribe?query=${encodeURIComponent('Transcribe my voicemail')}`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /nothing to transcribe/);
});

test('stt: private addresses are refused before any download', async (t) => {
  const base = startServer(t);
  const body = await (await fetch(`${base}/transcribe?query=${encodeURIComponent('Transcribe http://169.254.169.254/a.mp3')}`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.match(body.summary, /private or internal/);
});

test('stt: downloads the file and returns the transcript the model wrote', async (t) => {
  process.env.GEMINI_API_KEY = 'test-key';
  const base = startServer(t);
  stubFetch(t, async (url) => {
    if (url.startsWith('http://93.184.216.34/')) return new Response(Buffer.alloc(2048), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"language":"English","transcript":"Hello from the test."}' }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const body = await (await fetch(`${base}/transcribe?query=${encodeURIComponent('Transcribe http://93.184.216.34/clip.mp3')}`)).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.transcript, 'Hello from the test.');
  assert.equal(body.language, 'English');
  assert.match(body.summary, /Transcript \(English\): Hello from the test\./);
});

test('stt: a non-audio link is refused, no transcript is invented', async (t) => {
  process.env.GEMINI_API_KEY = 'test-key';
  const base = startServer(t);
  stubFetch(t, async () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  const body = await (await fetch(`${base}/transcribe?audio_url=${encodeURIComponent('http://93.184.216.34/page')}&query=transcribe`)).json();
  assert.equal(body.status, 'invalid_input');
  assert.equal(body.transcript, undefined);
});

test('stt: model failure is reported as unavailable with no transcript', async (t) => {
  process.env.GEMINI_API_KEY = 'test-key';
  const base = startServer(t);
  stubFetch(t, async (url) => {
    if (url.startsWith('http://93.184.216.34/')) return new Response(Buffer.alloc(512), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    return new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } });
  });
  const body = await (await fetch(`${base}/transcribe?query=${encodeURIComponent('Transcribe http://93.184.216.34/a.wav')}`)).json();
  assert.equal(body.status, 'unavailable');
  assert.equal(body.transcript, null);
});
