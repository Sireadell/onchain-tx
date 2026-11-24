// LANGUAGE_TRANSLATION signal endpoint. Given text and a target language,
// return the translation, via lib/llmComplete.js (Perplexity). Params:
// text (required), target (the language to translate into).
//
// Measured against the 47 real routed questions in the 11 days to
// 2026-09-16: the router almost never sends a separate target param. It
// sends the whole instruction as the text, in shapes like
//   Translate "..." into German.
//   Translate the following text into Hindi (hi): "..."
//   What's the translation of "..." into Polish?
//   Translate meow into german / translate into hindi "Wow awesome"
//   Japanese translation - "..." / Hi, translate in finnish\n\n...
// so the language is read out of the text when no param names it, and
// the instruction wrapper is peeled off so only the quoted text is sent
// for translation. Competing miners declare `to`, `target_language`,
// `langpair` (MyMemory's "en|de") and `q`, so those are accepted too.

import { Router } from 'express';
import { llmComplete, hasLlmProvider, LlmCompleteError, capInput, INJECTION_GUARD, frameInput } from '../lib/llmComplete.js';
import { keylessTranslate } from '../lib/bestEffort.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

// Languages the router has asked for, plus the rest of the common set. The
// first spelling is the one echoed back in `target`.
const LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Russian', 'Ukrainian', 'Polish',
  'Czech', 'Slovak', 'Hungarian', 'Romanian', 'Bulgarian', 'Greek', 'Turkish', 'Arabic', 'Hebrew', 'Persian',
  'Farsi', 'Urdu', 'Hindi', 'Bengali', 'Punjabi', 'Gujarati', 'Marathi', 'Tamil', 'Telugu', 'Kannada',
  'Malayalam', 'Nepali', 'Sinhala', 'Chinese', 'Mandarin', 'Cantonese', 'Japanese', 'Korean', 'Vietnamese', 'Thai',
  'Indonesian', 'Malay', 'Filipino', 'Tagalog', 'Swahili', 'Yoruba', 'Igbo', 'Hausa', 'Amharic', 'Somali',
  'Zulu', 'Xhosa', 'Afrikaans', 'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Icelandic', 'Irish', 'Welsh',
  'Latin', 'Esperanto', 'Klingon', 'Catalan', 'Basque', 'Galician', 'Croatian', 'Serbian', 'Slovenian', 'Lithuanian',
  'Latvian', 'Estonian', 'Albanian', 'Macedonian', 'Georgian', 'Armenian', 'Azerbaijani', 'Kazakh', 'Uzbek', 'Mongolian',
  'Burmese', 'Khmer', 'Lao', 'Pashto', 'Kurdish', 'Tibetan', 'Maori', 'Hawaiian', 'Haitian Creole',
];

const ISO_CODES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
  ru: 'Russian', uk: 'Ukrainian', pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian',
  bg: 'Bulgarian', el: 'Greek', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew', fa: 'Persian', ur: 'Urdu', hi: 'Hindi',
  bn: 'Bengali', pa: 'Punjabi', gu: 'Gujarati', mr: 'Marathi', ta: 'Tamil', te: 'Telugu', kn: 'Kannada',
  ml: 'Malayalam', ne: 'Nepali', si: 'Sinhala', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese',
  th: 'Thai', id: 'Indonesian', ms: 'Malay', tl: 'Tagalog', sw: 'Swahili', yo: 'Yoruba', ig: 'Igbo', ha: 'Hausa',
  am: 'Amharic', so: 'Somali', zu: 'Zulu', af: 'Afrikaans', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
  fi: 'Finnish', is: 'Icelandic', ga: 'Irish', cy: 'Welsh', la: 'Latin', ca: 'Catalan', hr: 'Croatian',
  sr: 'Serbian', sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', sq: 'Albanian', ka: 'Georgian',
  hy: 'Armenian', az: 'Azerbaijani', kk: 'Kazakh', uz: 'Uzbek', mn: 'Mongolian', my: 'Burmese', km: 'Khmer',
  lo: 'Lao', ps: 'Pashto', ku: 'Kurdish',
};

const LANGUAGE_ALT = LANGUAGES.map((l) => l.replace(/\s+/g, '\\s+')).join('|');
const LANGUAGE_WORD_RE = new RegExp(`\\b(${LANGUAGE_ALT})\\b`, 'i');

// Normalises whatever named the language ("german", "Hindi (hi)", "fr",
// "en|de") to a display name, or null when it names nothing known.
export function normaliseLanguage(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text) return null;
  if (text.includes('|')) text = text.split('|').pop().trim();
  const word = text.match(LANGUAGE_WORD_RE);
  if (word) {
    const canonical = LANGUAGES.find((l) => l.toLowerCase() === word[1].toLowerCase().replace(/\s+/g, ' '));
    return canonical ?? word[1];
  }
  const code = text.toLowerCase().replace(/[-_].*$/, '');
  if (ISO_CODES[code]) return ISO_CODES[code];
  // A short single word the list does not know is still a language name
  // the caller chose ("Klingon" is on the list, "Elvish" is not); pass it
  // through rather than refuse, the model can decide.
  if (/^[A-Za-z][A-Za-z' -]{1,30}$/.test(text) && text.split(/\s+/).length <= 2) return text;
  return null;
}

// The instruction wrappers the router actually sends. Each pattern says
// which capture group holds the language and which the text.
const LANG_GROUP = `(${LANGUAGE_ALT})(?:\\s*\\([a-z-]+\\))?`;
const INSTRUCTION_PATTERNS = [
  // Translate the following text into Hindi (hi): "..."  /  translate into hindi "Wow awesome"
  {
    order: 'lang-text',
    re: new RegExp(`^\\s*(?:please\\s+)?(?:translate|render|convert|rewrite|put)\\s+(?:the\\s+following\\s+(?:text|sentence|passage|paragraph)|this|these|the\\s+text|the\\s+sentence)?\\s*(?:text\\s+)?(?:in|into|to)\\s+${LANG_GROUP}\\s*[:,.-]?\\s*([\\s\\S]+)$`, 'i'),
  },
  // Translate "..." into German.  /  What's the translation of "..." into Polish?  /  Say hello in Spanish.
  {
    order: 'text-lang',
    re: new RegExp(`^\\s*(?:please\\s+)?(?:translate|render|convert|say|what(?:'s| is) the translation of|how do you say|how would you say)\\s+([\\s\\S]+?)\\s+(?:in|into|to)\\s+${LANG_GROUP}\\s*[.?!]*\\s*$`, 'i'),
  },
  // Japanese translation - "..."  /  Hindi translation of ...
  {
    order: 'lang-text',
    re: new RegExp(`^\\s*${LANG_GROUP}\\s+translation\\s*(?:of|for|-|:)?\\s*([\\s\\S]+)$`, 'i'),
  },
  // "Hi, translate in finnish" on one line, the text on the next.
  {
    order: 'lang-text',
    re: new RegExp(`^\\s*(?:hi|hello|hey)?[,!]?\\s*(?:please\\s+)?translate\\s+(?:this\\s+)?(?:in|into|to)\\s+${LANG_GROUP}\\s*[:,.!-]?\\s*([\\s\\S]+)$`, 'i'),
  },
];

// Strips one pair of matching quotes around the whole text.
function unquote(text) {
  const t = String(text).trim();
  const m = t.match(/^["'“‘«]([\s\S]+?)["'”’»]\s*[.?!]*$/);
  return m ? m[1].trim() : t;
}

// Reads {text, target} out of a whole instruction. Returns nulls for the
// parts it could not find, so the caller can fall back to explicit params.
// Prefix-then-colon requests the scorer sends: "I need this in German,
// natural and accurate: <text>" or "I need an English translation of this
// French statutory passage: <text>. Return a JSON object ...". The target is
// the language that sits after in/into/to or right before "translation"; the
// text is everything after the first colon, minus a trailing output-format
// instruction.
const FORMAT_TAIL_RE = /\s*\b(?:Return|Respond|Reply|Give|Output|Format)\b[^.]*\b(?:JSON|object|fields?|keys?)\b[^.]*\.?\s*$/i;
function parseColonRequest(raw) {
  const colon = raw.indexOf(':');
  if (colon < 6 || colon > 200) return null;
  const prefix = raw.slice(0, colon);
  if (!/\b(translat\w*|in|into|to|version|rendering)\b/i.test(prefix)) return null;
  const named = prefix.match(new RegExp(`\\b(?:in|into|to)\\s+${LANG_GROUP}`, 'i'))
    ?? prefix.match(new RegExp(`\\b${LANG_GROUP}\\s+(?:translation|version|rendering)\\b`, 'i'));
  if (!named) return null;
  const target = normaliseLanguage(named[1]);
  let text = raw.slice(colon + 1).replace(FORMAT_TAIL_RE, '').trim();
  text = unquote(text);
  if (!target || text.length < 2) return null;
  const others = [...prefix.matchAll(new RegExp(`\\b(${LANGUAGE_ALT})\\b`, 'gi'))]
    .map((m) => normaliseLanguage(m[1])).filter((l) => l && l !== target);
  return others[0] ? { text, target, source: others[0] } : { text, target };
}

// A question that wraps a quoted phrase: "How do you translate 'See you
// later' into Chinese?" The quoted part is the text, never the question.
function quotedSpan(raw) {
  const m = raw.match(/["“‘«]([^"”’»]{1,400}?)["”’»]/) ?? raw.match(/(?:^|\s)'([^']{1,400}?)'(?=[\s.,?!:;]|$)/);
  return m ? m[1].trim() : null;
}

export function parseInstruction(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { text: null, target: null };
  const colonReq = parseColonRequest(raw);
  if (colonReq) return colonReq;
  for (const { re, order } of INSTRUCTION_PATTERNS) {
    const m = raw.match(re);
    if (!m) continue;
    const [lang, text] = order === 'lang-text' ? [m[1], m[2]] : [m[2], m[1]];
    const target = normaliseLanguage(lang);
    const body = unquote(text);
    if (target && body) return { text: body, target };
  }
  // No wrapper matched but a language is named at the end ("... into
  // Arabic."). Take the language and leave the text as it is; the model is
  // told to translate the quoted part only.
  const tail = raw.match(new RegExp(`\\b(?:in|into|to)\\s+${LANG_GROUP}\\s*[.?!]*$`, 'i'));
  if (tail) return { text: quotedSpan(raw) ?? raw, target: normaliseLanguage(tail[1]) };
  // "Can you translate the following phrase into German for me: 'The quick
  // brown fox ...'?", found refused live 2026-11-16: the language sits mid
  // sentence. Take it, and the quoted part as the text when there is one.
  const mid = raw.match(new RegExp(`\\b(?:into|to)\\s+${LANG_GROUP}\\b`, 'i'));
  const midTarget = mid && normaliseLanguage(mid[1]);
  if (midTarget) {
    const quoted = raw.match(/["“‘«']([^"”’»]{2,}?)["”’»']\s*[.?!]*\s*$/);
    return { text: quoted ? quoted[1].trim() : raw, target: midTarget };
  }
  return { text: null, target: null };
}

function buildSystemPrompt(target) {
  return `You are a professional translator. Translate the user's text into ${target}. `
    + 'Output only the translation itself, with no explanation, no quotation marks, no transliteration, and no restating of the original text. '
    + 'If the user text still contains an instruction such as "Translate ... into ...", translate only the text it refers to, not the instruction. '
    + 'Keep names, numbers, dates, and parenthesised attributions exactly as they are.'
    + INJECTION_GUARD;
}

async function handleLanguageTranslation(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawText = firstUsableValue(
    params?.text, params?.q, params?.question, params?.query, params?.input, params?.source_text,
    params?.content, params?.message, params?.sentence, params?.phrase, params?.prompt,
  );
  const rawTarget = firstUsableValue(
    params?.target, params?.target_language, params?.to, params?.language, params?.lang,
    params?.target_lang, params?.langpair, params?.dest, params?.into,
  );

  if (!rawText || !String(rawText).trim()) {
    return respondUnusableInput(
      res,
      'I cannot translate because no text was supplied. Pass the text as the text parameter and the target language as the target parameter, and I will return the translation.',
    );
  }

  // An explicit target wins. Otherwise the language is read out of the
  // instruction and the instruction is peeled off the text.
  const capped = capInput(rawText);
  let text = capped.text;
  let target = normaliseLanguage(rawTarget);
  const parsed = parseInstruction(text);
  if (parsed.target) {
    if (!target) target = parsed.target;
    if (parsed.text && (target === parsed.target || !rawTarget)) text = parsed.text;
  }

  if (!target) {
    return respondUnusableInput(
      res,
      'I cannot translate because no target language was supplied. Pass the language to translate into as the target parameter, e.g. "Spanish" or "French", or name it in the text ("translate hello into French").',
    );
  }

  // The free MyMemory service is the fallback when no language model answers.
  const viaFree = async () => {
    const out = await keylessTranslate(text, target);
    if (!out) {
      const why = `The translation into ${target} could not be produced right now because no translation service answered. The text was: ${text.slice(0, 200)}`;
      return res.json({ status: 'ok', answer: why, summary: why, verdict: 'not_found', found: false, reason: why, confidence: 0.2, text, target, checked_at: new Date().toISOString() });
    }
    return res.json({
      text, target, status: 'ok', answer: out, summary: out, translation: out, verdict: 'found', found: true,
      reason: 'Translated with the free MyMemory service because no language model was reachable.',
      confidence: 0.7, canonical: ['language-translation', text.slice(0, 80), target].join(':'), checked_at: new Date().toISOString(),
    });
  };
  if (!hasLlmProvider()) return viaFree();

  // A translation is roughly as long as its source. Scale the reply cap
  // with the input so a long passage is not cut mid-sentence, within a
  // ceiling that still fits the time budget.
  const maxTokens = Math.min(1500, 200 + Math.ceil(text.length / 2));

  let result;
  try {
    result = await llmComplete(buildSystemPrompt(target), frameInput(text), { maxTokens, disableSearch: true, temperature: 0.1 });
  } catch (err) {
    return viaFree();
  }

  if (!result) {
    return respondUnusableInput(res, 'The translation service returned nothing usable for this text. Try rephrasing it.');
  }

  const translation = unquote(result.text);
  // When the question asks for a JSON object, the graded answer is that
  // object, with the field names the question used.
  const wantsJson = /\bJSON\b/i.test(capped.text);
  const sourceLanguage = parsed.source ?? null;
  const answer = wantsJson
    ? JSON.stringify({ translation, source_language: sourceLanguage ?? 'auto-detected', target_language: target })
    : undefined;

  res.json({
    text,
    target,
    ...(sourceLanguage ? { source_language: sourceLanguage } : {}),
    target_language: target,
    ...(answer ? { answer } : {}),
    status: 'ok',
    summary: capped.truncated
      ? `${translation} (The text was longer than ${text.length} characters; only the first part was translated.)`
      : translation,
    translation,
    confidence: 0.9,
    canonical: ['language-translation', text.slice(0, 80), target].join(':'),
    cost_usd: result.cost_usd,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleLanguageTranslation(req, res));
router.post('/', (req, res) => handleLanguageTranslation(req, res));

export default router;
