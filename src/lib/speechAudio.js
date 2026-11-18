// Text to speech and speech to text through Google Gemini (free allowance key,
// GEMINI_API_KEY). Nothing here is paid or guaranteed: with no key, or when
// Gemini refuses, the callers answer honestly that no audio or transcript was
// produced. A transcript is only ever what the model heard in the real file.

import { geminiModels, hasGemini } from './llmProviders.js';
import { parsePublicUrl, assertResolvesPublic } from './ssrfGuard.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export class SpeechError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
  }
}

export const VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
export const MAX_TTS_CHARS = 1_200;
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const ttsModels = () => [...new Set([process.env.GEMINI_TTS_MODEL, 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean))];

async function geminiPost(model, body, budgetMs) {
  const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(budgetMs),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => null);
    throw new SpeechError(`gemini ${model} answered HTTP ${res.status}${err?.error?.message ? `: ${String(err.error.message).slice(0, 120)}` : ''}`, { status: res.status });
  }
  return res.json();
}

// 16-bit mono PCM in a 44 byte WAV header.
export function pcmToWav(pcm, sampleRate = 24_000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Cuts text to the limit at a sentence end where one exists.
export function clipText(text, max = MAX_TTS_CHARS) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return { text: clean, truncated: false };
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return { text: stop > max * 0.5 ? cut.slice(0, stop + 1) : cut, truncated: true };
}

export async function synthesize(text, voice = 'Kore', { budgetMs = 25_000 } = {}) {
  if (!hasGemini()) throw new SpeechError('no speech model key is configured (GEMINI_API_KEY)');
  const reasons = [];
  for (const model of ttsModels()) {
    try {
      const body = await geminiPost(model, {
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }, budgetMs);
      const part = (body?.candidates?.[0]?.content?.parts ?? []).find((p) => p?.inlineData?.data);
      if (!part) throw new SpeechError(`gemini ${model} returned no audio`);
      const bytes = Buffer.from(part.inlineData.data, 'base64');
      const mime = String(part.inlineData.mimeType ?? '').toLowerCase();
      const rate = Number(/rate=(\d+)/.exec(mime)?.[1]) || 24_000;
      const isWav = bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF';
      const wav = isWav ? bytes : pcmToWav(bytes, rate);
      const sampleRate = wav.readUInt32LE(24);
      const durationS = Math.round(((wav.length - 44) / (sampleRate * 2)) * 10) / 10;
      return { wav, model, sampleRate, durationS };
    } catch (err) {
      reasons.push(err.message);
      if (err.status && ![400, 404, 429, 500, 503].includes(err.status)) break;
    }
  }
  throw new SpeechError(reasons.join(' | ') || 'speech synthesis failed');
}

// Short-lived in-memory store so the answer can carry a playable link.
const clips = new Map();
const MAX_CLIPS = 24;
const CLIP_TTL_MS = 60 * 60_000;
export function storeClip(id, wav) {
  for (const [k, v] of clips) if (v.expires < Date.now()) clips.delete(k);
  while (clips.size >= MAX_CLIPS) clips.delete(clips.keys().next().value);
  const expires = Date.now() + CLIP_TTL_MS;
  clips.set(id, { wav, expires });
  return new Date(expires).toISOString();
}
export function getClip(id) {
  const c = clips.get(id);
  return c && c.expires > Date.now() ? c.wav : null;
}

const AUDIO_MIME = { mp3: 'audio/mp3', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/aac', aac: 'audio/aac', opus: 'audio/ogg' };

export function audioUrlFromText(text) {
  const found = String(text ?? '').match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  const urls = found.map((u) => u.replace(/[.,;)\]]+$/, ''));
  return urls.find((u) => /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)(\?|#|$)/i.test(u)) ?? urls[0] ?? null;
}

// Downloads a public audio file with the private-address checks applied on
// every redirect hop and a hard size cap.
export async function fetchAudio(rawUrl, { budgetMs = 15_000 } = {}) {
  let url = rawUrl;
  for (let hop = 0; hop < 4; hop += 1) {
    const parsed = parsePublicUrl(url, SpeechError, 'fetched');
    await assertResolvesPublic(parsed, SpeechError, 'fetched');
    let res;
    try {
      res = await fetch(parsed, { redirect: 'manual', signal: AbortSignal.timeout(budgetMs), headers: { 'user-agent': 'txlens-stt/1.0' } });
    } catch (err) {
      throw new SpeechError(`the audio file could not be downloaded (${err.name === 'TimeoutError' ? 'timed out' : err.message})`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), parsed).toString();
      continue;
    }
    if (!res.ok) throw new SpeechError(`the audio file could not be downloaded (HTTP ${res.status})`, { status: res.status });
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_AUDIO_BYTES) throw new SpeechError(`the audio file is ${Math.round(declared / 1048576)} MB, over the 8 MB limit`);
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) throw new SpeechError('the audio file is over the 8 MB limit');
      chunks.push(chunk);
    }
    const ext = /\.([a-z0-9]{2,4})$/i.exec(parsed.pathname)?.[1]?.toLowerCase();
    const headerMime = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const mime = headerMime.startsWith('audio/') ? headerMime : AUDIO_MIME[ext] ?? null;
    if (!mime) throw new SpeechError(`the link is not an audio file (content type ${headerMime || 'unknown'})`);
    return { bytes: Buffer.concat(chunks), mime, host: parsed.hostname };
  }
  throw new SpeechError('the audio link redirected too many times');
}

export async function transcribe({ bytes, mime }, { budgetMs = 40_000 } = {}) {
  if (!hasGemini()) throw new SpeechError('no speech model key is configured (GEMINI_API_KEY)');
  const reasons = [];
  const prompt = 'Transcribe the speech in this audio exactly as spoken, in its original language, with no translation and no commentary. '
    + 'Reply with a JSON object {"language":"<English name of the spoken language>","transcript":"<the words spoken>"}. '
    + 'If there is no intelligible speech, use an empty transcript.';
  for (const model of geminiModels().filter((m) => !/gemma/i.test(m))) {
    try {
      const body = await geminiPost(model, {
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: bytes.toString('base64') } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4000, responseMimeType: 'application/json' },
      }, budgetMs);
      const raw = (body?.candidates?.[0]?.content?.parts ?? []).filter((p) => !p?.thought).map((p) => p?.text ?? '').join('').trim();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      const transcript = String(parsed?.transcript ?? (parsed ? '' : raw)).replace(/\s+/g, ' ').trim();
      return { transcript, language: parsed?.language ? String(parsed.language) : null, model };
    } catch (err) {
      reasons.push(err.message);
      if (err.status && ![400, 404, 429, 500, 503].includes(err.status)) break;
    }
  }
  throw new SpeechError(reasons.join(' | ') || 'transcription failed');
}
