import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { textToSpeak, voiceFrom } from './checkTextToSpeech.js';
import { pcmToWav, clipText } from '../lib/speechAudio.js';

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

test('tts: instruction lead and quotes are dropped, plain text is kept', () => {
  assert.equal(textToSpeak('Your package will arrive on Tuesday.'), 'Your package will arrive on Tuesday.');
  assert.equal(textToSpeak('Convert this to speech: Hello there friend'), 'Hello there friend');
  assert.equal(textToSpeak('Please read aloud "Meeting at nine"'), 'Meeting at nine');
});

test('tts: voice names are read from the request, default Kore', () => {
  assert.equal(voiceFrom({}, 'say hi'), 'Kore');
  assert.equal(voiceFrom({ voice: 'puck' }, 'say hi'), 'Puck');
  assert.equal(voiceFrom({}, 'say hi in the Fenrir voice'), 'Fenrir');
});

test('tts: long text is cut at a sentence end and flagged', () => {
  const long = 'Short sentence here. '.repeat(100);
  const out = clipText(long, 1200);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length <= 1200 && out.text.endsWith('.'));
});

test('tts: pcm is wrapped in a valid wav header', () => {
  const wav = pcmToWav(Buffer.alloc(48000), 24000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 48044);
});

test('tts: returns a playable clip link and serves the wav', async (t) => {
  process.env.GEMINI_API_KEY = 'test-key';
  const base = startServer(t);
  stubFetch(t, async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(48000).toString('base64') } }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const res = await fetch(`${base}/tts?query=${encodeURIComponent('Your package will arrive on Tuesday.')}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.duration_s, 1);
  assert.equal(body.voice, 'Kore');
  assert.match(body.audio_url, /\/tts\/audio\/[a-f0-9]{32}\.wav$/);
  assert.match(body.summary, /Spoken audio generated/);
  const audio = await fetch(body.audio_url);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.equal((await audio.arrayBuffer()).byteLength, 48044);
});

test('tts: a missing key answers honestly with the text and no audio', async (t) => {
  delete process.env.GEMINI_API_KEY;
  const base = startServer(t);
  const body = await (await fetch(`${base}/tts?query=Hello+world+again`)).json();
  assert.equal(body.status, 'unavailable');
  assert.equal(body.audio_url, null);
  assert.equal(body.text, 'Hello world again');
});

test('tts: empty input is answered, not a bare 400', async (t) => {
  const base = startServer(t);
  const res = await fetch(`${base}/tts`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'invalid_input');
});
