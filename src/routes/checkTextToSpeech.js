// TEXT_TO_SPEECH_GENERAL signal endpoint. Speaks the given text with a Gemini
// speech model and returns a playable WAV link (kept one hour) plus, for short
// clips, the audio itself in base64. With no speech key or when the model
// refuses, it says so and returns the text unchanged instead of pretending.

import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import {
  synthesize, clipText, storeClip, getClip, VOICES, MAX_TTS_CHARS, SpeechError,
} from '../lib/speechAudio.js';

const router = Router();
const MAX_BASE64_WAV_BYTES = 400_000;
const now = () => new Date().toISOString();

// Drops an instruction lead such as "Convert this to speech:" or "Say aloud -".
const LEAD_RE = /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:convert|turn|read|say|speak|voice|narrate|synthesi[sz]e|generate|make|produce|create|record)\b[^:\n"“]{0,80}?(?:aloud|to speech|into speech|as audio|to audio|into audio|as speech|speech|audio|text)?\s*[:\-]\s+/i;

export function textToSpeak(raw) {
  const value = String(raw ?? '').trim();
  const quoted = value.match(/["“]([^"”]{3,})["”]/);
  if (quoted && value.length > quoted[1].length + 8) return quoted[1].trim();
  const stripped = value.replace(LEAD_RE, '').trim();
  return stripped || value;
}

export function voiceFrom(params, raw) {
  const wanted = String(firstUsableValue(params.voice, params.speaker) ?? '');
  const hay = `${wanted} ${raw}`.toLowerCase();
  return VOICES.find((v) => new RegExp(`\\b${v.toLowerCase()}\\b`).test(hay)) ?? 'Kore';
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = String(req.get('x-forwarded-proto') ?? req.protocol).split(',')[0];
  return `${proto}://${req.get('host')}`;
}

router.get('/audio/:file', (req, res) => {
  const id = String(req.params.file).replace(/\.wav$/i, '');
  const wav = /^[a-f0-9]{32}$/.test(id) ? getClip(id) : null;
  if (!wav) return res.status(404).json({ status: 'not_found', summary: 'This audio clip has expired or never existed. Clips are kept for one hour.', confidence: 1 });
  res.set('Content-Type', 'audio/wav');
  res.set('Cache-Control', 'public, max-age=3600');
  return res.send(wav);
});

async function handler(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const raw = firstUsableValue(params.text, params.query, params.q, params.question, params.input, params.content);
  if (!raw || !String(raw).trim()) {
    return respondUnusableInput(res, 'No text to speak was supplied. Pass the words to be spoken as the text or query parameter.');
  }
  const { text, truncated } = clipText(textToSpeak(raw));
  if (!text) return respondUnusableInput(res, 'The text to speak was empty after cleaning.');
  const voice = voiceFrom(params, raw);
  try {
    const clip = await synthesize(text, voice);
    const id = createHash('sha256').update(randomBytes(16)).digest('hex').slice(0, 32);
    const expiresAt = storeClip(id, clip.wav);
    const audioUrl = `${baseUrl(req)}/tts/audio/${id}.wav`;
    const checkedAt = now();
    const summary = `Spoken audio generated for ${text.length} characters in the ${voice} voice: ${clip.durationS} s of 16-bit mono WAV at ${clip.sampleRate} Hz, made by ${clip.model}`
      + `${truncated ? `, with the text cut at ${MAX_TTS_CHARS} characters` : ''}. Playable at ${audioUrl} (kept 1 hour). Source: Google Gemini speech model. Generated ${checkedAt}.`;
    return res.json({
      status: 'ok',
      verdict: 'found',
      summary,
      answer: summary,
      confidence: 0.85,
      text,
      characters: text.length,
      truncated,
      audio_url: audioUrl,
      audio_expires_at: expiresAt,
      audio_base64: clip.wav.length <= MAX_BASE64_WAV_BYTES ? clip.wav.toString('base64') : null,
      mime_type: 'audio/wav',
      sample_rate_hz: clip.sampleRate,
      duration_s: clip.durationS,
      voice,
      model: clip.model,
      source: 'Google Gemini speech model',
      checked_at: checkedAt,
    });
  } catch (err) {
    if (!(err instanceof SpeechError)) throw err;
    const summary = `No audio was produced: the speech service did not return a clip at request time (${err.message}). `
      + `The text that would have been spoken (${text.length} characters, ${voice} voice) is returned unchanged and nothing is invented. Checked ${now()}.`;
    return res.json({
      status: 'unavailable', verdict: 'unavailable', summary, answer: summary, confidence: 0.2, text, characters: text.length, voice, audio_url: null, audio_base64: null, checked_at: now(),
    });
  }
}

router.get('/', handler);
router.post('/', handler);

export default router;
