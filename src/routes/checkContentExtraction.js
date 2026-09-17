// CONTENT_EXTRACTION signal endpoint. Fetches a URL and returns its title
// and readable text (lib/contentExtract.js). Params: url (required, also
// accepted as link/page/href/question/query/q/text, from which a URL is
// pulled out if the caller sent a whole sentence). A bare host
// ("github.com/torvalds") is given the https scheme it is missing.
//
// Real traffic also sends a passage of text with no URL at all ("Extract
// the dates, quantities, named entities and events from: ..."), which the
// dispatcher routes here because the word "extract" is in it. Refusing
// that is a delivered zero; an extraction of what the passage actually
// contains can score, so it is answered from the text itself.

import { Router } from 'express';
import { extractContent, ContentExtractError } from '../lib/contentExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';
import {
  llmComplete, hasLlmProvider, frameInput, capInput, INJECTION_GUARD, LlmCompleteError,
} from '../lib/llmComplete.js';

const router = Router();

const URL_KEYS = ['url', 'link', 'page', 'href', 'website', 'question', 'query', 'q', 'text', 'input', 'content'];
const URL_RE = /https?:\/\/[^\s<>"')\]]+/i;
// A host with a dot and a known-looking TLD, with an optional path, not
// preceded by a scheme: "github.com/torvalds", "www.bbc.co.uk".
const BARE_HOST_RE = /(?:^|[\s:(,])((?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|ai|co|uk|de|fr|jp|in|ng|au|ca|us|info|dev|app|xyz|me|tv|ly|to|sh|so|eu|es|it|nl|se|no|br|ru|ch|be|at|pl|cz|za|kr|cn|hk|sg|nz|ie|fi|dk|pt|gr|tr|mx|ar|cl|id|ph|my|th|vn|pk|bd|lk|ae|sa|il|edu\.[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2}|org\.[a-z]{2})(?:\/[^\s<>"')\]]*)?)(?=$|[\s),.;!?])/i;

// The passage path only runs on text long enough to be a passage. A short
// non-URL value is a mistyped URL and gets the URL guidance instead.
const MIN_PASSAGE_CHARS = 40;
const MAX_PASSAGE_CHARS = 8_000;
const PASSAGE_BUDGET_MS = 9_000;
const SUMMARY_TEXT_CHARS = 1_200;

const PASSAGE_SYSTEM_PROMPT = 'You extract structured facts from a passage of text. '
  + 'Report, in plain prose with no markdown, headings or bullet points: the dates and time references it mentions, '
  + 'the quantities and numbers with their units, the named entities (people, organisations, places, products, works), '
  + 'and the events or actions described. If the passage contains none of a category, say so in a few words. '
  + 'Open with one sentence saying what the passage is about. Keep the whole reply under 150 words. Never add facts that are not in the passage.'
  + INJECTION_GUARD;

function extractUrl(text) {
  if (typeof text !== 'string') return null;
  const full = text.match(URL_RE);
  if (full) return full[0].replace(/[.,;:!?]+$/, '');
  const bare = text.match(BARE_HOST_RE);
  if (bare) return `https://${bare[1].replace(/[.,;:!?]+$/, '')}`;
  return null;
}

// Strips the instruction the passage arrived with ("Extract the dates,
// quantities ... from:", "Here is a passage (as text):") so the extraction
// runs on the passage alone.
function passageBody(text) {
  return String(text)
    .replace(/^\s*(?:here is|here's)\s+(?:a|the)\s+(?:passage|text|excerpt|article)[^:]{0,40}:\s*/i, '')
    .replace(/^\s*(?:please\s+)?(?:extract|pull out|find|list|identify)\b[^:]{0,160}(?:from|in|of)\s*(?:this|the following|the)?\s*(?:text|passage|paragraph|article|excerpt)?\s*:\s*/i, '')
    .replace(/^["'“]|["'”]$/g, '')
    .trim();
}

// Without an LLM provider (or when it fails), a regex pass still names the
// dates, figures and capitalised entities in the passage, which is what
// the question asked for even if it reads less fluently.
function heuristicExtraction(passage) {
  const dates = [...new Set([...passage.matchAll(/\b(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(?:,\s*\d{4})?\b|\b(?:19|20)\d{2}\b|\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]))].slice(0, 8);
  const quantities = [...new Set([...passage.matchAll(/(?:[$€£]\s?\d[\d,.]*(?:\s?(?:million|billion|trillion|k|m|bn))?|\b\d[\d,.]*\s?(?:%|percent|km|m|kg|g|tons?|tonnes|miles|hours?|days?|weeks?|months?|years?|million|billion|trillion|people|units|dollars|euros))/gi)].map((m) => m[0].trim()))].slice(0, 8);
  const stop = /^(?:The|A|An|This|That|These|Those|In|On|At|For|From|With|By|To|Of|And|Or|But|It|Its|We|Our|They|Their|He|She|His|Her|If|As|Is|Are|Was|Were|Point|Here)$/;
  const entities = [...new Set([...passage.matchAll(/\b([A-Z][a-zA-Z'-]+(?:\s+(?:of|de|the)?\s*[A-Z][a-zA-Z'-]+){0,3})\b/g)]
    .map((m) => m[1])
    .filter((e) => !stop.test(e.split(/\s+/)[0]) || e.includes(' ')))].slice(0, 10);
  const firstSentence = passage.split(/(?<=[.!?])\s+/)[0]?.slice(0, 240) ?? '';
  const parts = [`The passage is about: ${firstSentence}`];
  parts.push(dates.length ? `Dates and time references: ${dates.join(', ')}.` : 'It mentions no specific dates.');
  parts.push(quantities.length ? `Quantities: ${quantities.join(', ')}.` : 'It gives no specific quantities.');
  parts.push(entities.length ? `Named entities: ${entities.join(', ')}.` : 'It names no specific people, organisations or places.');
  return parts.join(' ');
}

async function answerPassage(res, rawValue) {
  const { text: capped, truncated } = capInput(passageBody(rawValue), MAX_PASSAGE_CHARS);
  let extraction = null;
  let provider = 'heuristic';
  if (hasLlmProvider()) {
    try {
      const reply = await llmComplete(PASSAGE_SYSTEM_PROMPT, frameInput(capped), {
        budgetMs: PASSAGE_BUDGET_MS, maxTokens: 350, disableSearch: true,
      });
      const text = typeof reply === 'string' ? reply : reply?.text;
      if (text && String(text).trim()) {
        extraction = String(text).replace(/\s+/g, ' ').trim();
        provider = 'llm';
      }
    } catch (err) {
      if (!(err instanceof LlmCompleteError)) throw err;
    }
  }
  if (!extraction) extraction = heuristicExtraction(capped);

  const summary = `${extraction}${truncated ? ' (The passage was cut at 8,000 characters before extraction.)' : ''}`;
  res.json({
    status: 'ok',
    summary,
    confidence: provider === 'llm' ? 0.75 : 0.5,
    canonical: ['content-extraction', 'text', String(capped.length)].join(':'),
    title: null,
    text: capped.slice(0, SUMMARY_TEXT_CHARS),
    extracted_from: 'supplied text',
    provider,
    truncated,
    checked_at: new Date().toISOString(),
  });
}

function summarizePage(result) {
  const body = result.text.length > SUMMARY_TEXT_CHARS
    ? `${result.text.slice(0, SUMMARY_TEXT_CHARS).replace(/\s+\S*$/, '')}...`
    : result.text;
  let flat = body.replace(/\s*\n\s*/g, ' ');
  // The meta description is the page's own one-line summary; leading with
  // it puts the substance before whatever navigation text survived.
  if (result.description && !flat.includes(result.description)) flat = `${result.description} ${flat}`;
  const lead = result.title ? `"${result.title}": ` : '';
  const thinNote = result.thin ? ' (The page served little readable text without a login, so this is mostly what its metadata says.)' : '';
  return `${lead}${flat}${thinNote}`;
}

async function handleContentExtraction(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const values = URL_KEYS.map((k) => params[k]).filter((v) => typeof v === 'string' && v.trim());
  const rawValue = firstUsableValue(...values);

  if (!rawValue) {
    return respondUnusableInput(
      res,
      'I cannot extract content because no URL was supplied. Pass a URL as the url parameter and I will return the page title and its readable text.',
    );
  }

  let url = null;
  for (const value of values) {
    url = extractUrl(value);
    if (url) break;
  }

  if (!url) {
    if (String(rawValue).trim().length >= MIN_PASSAGE_CHARS) return answerPassage(res, rawValue);
    return respondUnusableInput(
      res,
      `I cannot extract content because ${quoteParam(rawValue)} does not contain a valid http or https URL. Pass a full URL, including the scheme, as the url parameter.`,
    );
  }

  let result;
  try {
    result = await extractContent(url);
  } catch (err) {
    if (err instanceof ContentExtractError) {
      return respondUnusableInput(res, `I could not extract content from ${quoteParam(url)}: ${err.message}.`);
    }
    return res.status(502).json({ status: 'error', summary: 'content extraction failed', confidence: 0, error: err.message });
  }

  res.json({
    url,
    status: 'ok',
    summary: summarizePage(result),
    confidence: result.thin ? 0.7 : 0.95,
    canonical: ['content-extraction', url].join(':'),
    title: result.title,
    description: result.description,
    author: result.author,
    published: result.published,
    site_name: result.site_name,
    text: result.text,
    content_type: result.content_type,
    final_url: result.final_url,
    truncated: result.truncated,
    full_length: result.full_length,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleContentExtraction(req, res));
router.post('/', (req, res) => handleContentExtraction(req, res));

export default router;
