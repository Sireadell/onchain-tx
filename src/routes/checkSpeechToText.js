// SPEECH_TO_TEXT_GENERAL signal endpoint. Downloads a public audio file
// (MP3, WAV, OGG, FLAC, M4A, up to 8 MB) after the private-address checks and
// has a Gemini speech model write the transcript. With no audio link it says
// plainly that nothing can be transcribed. A transcript is never invented.

import { Router } from 'express';
import { firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import {
  audioUrlFromText, fetchAudio, transcribe, SpeechError,
} from '../lib/speechAudio.js';

const router = Router();
const now = () => new Date().toISOString();

async function handler(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const explicit = firstUsableValue(params.audio_url, params.audio, params.url, params.file, params.link);
  const raw = firstUsableValue(params.query, params.q, params.question, params.text, params.input);
  const url = audioUrlFromText(explicit) ?? audioUrlFromText(raw);
  if (!url) {
    return respondUnusableInput(res, `No audio file was supplied${raw ? ` in ${quoteParam(raw)}` : ''}, so there is nothing to transcribe. Send a public link to an MP3, WAV, OGG, FLAC or M4A file (up to 8 MB), for example "Transcribe https://example.com/interview.mp3".`);
  }
  let audio;
  try {
    audio = await fetchAudio(url);
  } catch (err) {
    if (!(err instanceof SpeechError)) throw err;
    return respondUnusableInput(res, `The audio at ${quoteParam(url)} could not be used: ${err.message}.`);
  }
  try {
    const out = await transcribe(audio);
    const checkedAt = now();
    const found = out.transcript.length > 0;
    const summary = found
      ? `Transcript${out.language ? ` (${out.language})` : ''}: ${out.transcript} Source: ${audio.host} audio (${audio.mime}, ${Math.round(audio.bytes.length / 1024)} KB), transcribed by ${out.model}. Transcribed ${checkedAt}.`
      : `No intelligible speech was found in the audio file from ${audio.host} (${audio.mime}, ${Math.round(audio.bytes.length / 1024)} KB), so the transcript is empty. Checked ${checkedAt}.`;
    return res.json({
      status: 'ok',
      verdict: found ? 'found' : 'no_speech',
      summary,
      answer: summary,
      confidence: found ? 0.8 : 0.7,
      transcript: out.transcript,
      language: out.language,
      audio_url: url,
      audio_bytes: audio.bytes.length,
      model: out.model,
      method: `transcribed by ${out.model}`,
      source: 'Google Gemini speech model',
      checked_at: checkedAt,
    });
  } catch (err) {
    if (!(err instanceof SpeechError)) throw err;
    const summary = `No transcript was produced: the audio was downloaded (${audio.mime}, ${Math.round(audio.bytes.length / 1024)} KB from ${audio.host}) but the speech service did not return text at request time (${err.message}). Nothing is guessed. Checked ${now()}.`;
    return res.json({
      status: 'unavailable', verdict: 'unavailable', summary, answer: summary, confidence: 0.2, transcript: null, audio_url: url, checked_at: now(),
    });
  }
}

router.get('/', handler);
router.post('/', handler);

export default router;
