// MACRO_ECONOMIC_INDICATOR signal endpoint. Given a country and an
// indicator (GDP growth, inflation, or unemployment), reads the most
// recent published value from the World Bank. Accepts country names as
// well as ISO codes, and indicator names as well as World Bank codes, so a
// caller never has to know either.

import { Router } from 'express';
import {
  fetchMacroIndicator, resolveCountryCode, resolveIndicatorCode,
  MacroUpstreamError, MacroLookupError, WORLD_BANK_ATTRIBUTION,
} from '../lib/macroData.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const COUNTRY_PARAM_KEYS = ['country', 'country_name', 'nation', 'location'];
// economic_indicator is the name documented in miner.yaml (chosen to avoid
// a collision with THREAT_INTELLIGENCE's unrelated `indicator` input),
// so it must actually be accepted here too, not just documented.
const INDICATOR_PARAM_KEYS = ['indicator', 'economic_indicator', 'metric', 'measure', 'stat'];
const FREE_TEXT_KEYS = ['query', 'q', 'question', 'text', 'input', 'search'];

const MAX_INPUT_CHARS = 400;

function summarize(result) {
  const signed = result.value >= 0 ? `+${result.value.toFixed(2)}` : result.value.toFixed(2);
  return `${result.country}'s ${result.indicator} was ${signed}${result.unit === 'percent' ? '%' : ''} in ${result.year}, the most recent year the World Bank has published data for.`;
}

async function handleMacroEconomicIndicator(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};

  const countryRaw = firstUsableValue(...COUNTRY_PARAM_KEYS.map((k) => params[k]));
  const indicatorRaw = firstUsableValue(...INDICATOR_PARAM_KEYS.map((k) => params[k]));
  const freeText = firstUsableValue(...FREE_TEXT_KEYS.map((k) => params[k]));

  const inputForEcho = String(countryRaw ?? indicatorRaw ?? freeText ?? '').slice(0, MAX_INPUT_CHARS);

  if (!countryRaw && !indicatorRaw && !freeText) {
    return respondUnusableInput(
      res,
      'I cannot look up a macroeconomic indicator because no country or indicator was supplied. Pass a country (e.g. Japan) and an indicator (GDP growth, inflation, or unemployment).',
    );
  }

  let countryCode = resolveCountryCode(String(countryRaw ?? '').slice(0, MAX_INPUT_CHARS));
  let indicatorCode = resolveIndicatorCode(String(indicatorRaw ?? '').slice(0, MAX_INPUT_CHARS));

  // The router does not reliably send country and indicator as two separate
  // structured params; found live (2026-09-18): a whole question such as
  // "What is Japan's inflation rate?" arrived entirely in the country
  // field, with indicator absent, and the fallback below never ran because
  // it required a SEPARATE free-text param, not the structured one that
  // actually failed to resolve. Any of countryRaw, indicatorRaw, or
  // freeText that failed to resolve directly is now also tried as a whole
  // sentence to scan, not just a dedicated free-text field.
  const candidateTexts = [freeText, countryRaw, indicatorRaw]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => String(v).slice(0, MAX_INPUT_CHARS));

  for (const text of candidateTexts) {
    if (countryCode && indicatorCode) break;
    if (!countryCode) countryCode = resolveCountryCode(text);
    if (!indicatorCode) indicatorCode = resolveIndicatorCode(text);
    if (!countryCode) {
      // Try scanning individual words/phrases inside the free text.
      const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
      for (let i = 0; i < words.length && !countryCode; i += 1) {
        countryCode = resolveCountryCode(words[i]) ?? resolveCountryCode(`${words[i]} ${words[i + 1] ?? ''}`.trim());
      }
    }
  }

  if (!countryCode) {
    return respondUnusableInput(
      res,
      `${quoteParam(inputForEcho)} does not name a recognisable country. Pass a country name (e.g. Germany) or an ISO code (e.g. DE).`,
    );
  }
  if (!indicatorCode) {
    return respondUnusableInput(
      res,
      `${quoteParam(inputForEcho)} does not name a recognisable macroeconomic indicator. Try GDP growth, inflation, or unemployment.`,
    );
  }

  let result;
  try {
    result = await fetchMacroIndicator(countryCode, indicatorCode);
  } catch (err) {
    if (err instanceof MacroLookupError) {
      return respondUnusableInput(res, err.message);
    }
    if (err instanceof MacroUpstreamError) {
      return res.status(502).json({
        status: 'error',
        summary: 'The World Bank data API is temporarily unavailable, so this indicator could not be checked right now. Retry shortly.',
        confidence: 0,
        error: err.message,
      });
    }
    throw err;
  }

  res.json({
    status: 'ok',
    summary: summarize(result),
    confidence: 0.85,
    canonical: ['macro-economic-indicator', result.countryCode.toLowerCase(), result.indicatorCode.toLowerCase()].join(':'),
    country: result.country,
    country_code: result.countryCode,
    indicator: result.indicator,
    indicator_code: result.indicatorCode,
    year: result.year,
    value: result.value,
    unit: result.unit,
    source: 'World Bank',
    attribution: WORLD_BANK_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleMacroEconomicIndicator(req, res));
router.post('/', (req, res) => handleMacroEconomicIndicator(req, res));

export default router;
