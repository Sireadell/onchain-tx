// MACRO_ECONOMIC_INDICATOR signal endpoint. Given a country and an
// indicator (GDP growth, inflation, or unemployment), reads the most
// recent published value from the World Bank. Accepts country names as
// well as ISO codes, and indicator names as well as World Bank codes, so a
// caller never has to know either.

import { Router } from 'express';
import {
  fetchMacroIndicator, resolveCountryCode, resolveIndicatorCode,
  MacroUpstreamError, MacroLookupError, WORLD_BANK_ATTRIBUTION, indicatorLabel, indicatorUnit,
} from '../lib/macroData.js';
import {
  fetchPolicyRate, resolvePolicyRegion, policyRateSummary, POLICY_RATE_RE, POLICY_REGIONS, PolicyRateUpstreamError,
} from '../lib/policyRates.js';
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

function formatValue(value, unit) {
  if (!Number.isFinite(value)) return String(value);
  if (unit === 'percent' || unit === 'percent of GDP') {
    return `${value.toFixed(2)}%${unit === 'percent of GDP' ? ' of GDP' : ''}`;
  }
  if (unit === 'current US dollars') {
    if (Math.abs(value) >= 1e12) return `$${(value / 1e12).toFixed(2)} trillion`;
    if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)} billion`;
    return `$${Math.round(value).toLocaleString('en-US')}`;
  }
  if (unit === 'people') {
    if (value >= 1e6) return `${(value / 1e6).toFixed(2)} million people`;
    return `${Math.round(value).toLocaleString('en-US')} people`;
  }
  return value.toFixed(2);
}

// One sentence with the figure and its year, then the direction against the
// year before and the recent series, so the reader sees the trend and not a
// lone number.
export function summarize(result, askedYear = null) {
  const head = `${result.country}'s ${result.indicator} was ${formatValue(result.value, result.unit)} in ${result.year}, the latest annual figure published by the ${result.source ?? 'World Bank'}.`;
  const hist = Array.isArray(result.history) ? result.history.filter((h) => Number.isFinite(h.value)) : [];
  const parts = [head];
  if (hist.length >= 2) {
    const prev = hist[1];
    const diff = result.value - prev.value;
    const pct = result.unit === 'percent' || result.unit === 'percent of GDP';
    const change = pct ? `${Math.abs(diff).toFixed(2)} percentage points` : formatValue(Math.abs(diff), result.unit);
    const dir = Math.abs(diff) < 1e-9 ? `unchanged from ${prev.year}` : `${diff > 0 ? 'up' : 'down'} ${change} from ${formatValue(prev.value, result.unit)} in ${prev.year}`;
    parts.push(`That is ${dir}.`);
    if (hist.length >= 3) {
      parts.push(`Recent series: ${hist.slice(0, 5).map((h) => `${h.year} ${formatValue(h.value, result.unit)}`).join(', ')}.`);
    }
  }
  if (askedYear && String(askedYear) !== String(result.year)) {
    const hit = hist.find((h) => String(h.year) === String(askedYear));
    if (hit) parts.push(`For ${askedYear} specifically, the annual figure was ${formatValue(hit.value, result.unit)}; the source publishes annual figures only, not monthly readings.`);
  }
  if (result.projection) parts.push(`The IMF projects ${formatValue(result.projection.value, result.unit)} for ${result.projection.year}.`);
  if (result.stale) parts.push('Both live statistics sources were slow at request time, so this is the last figure read from them.');
  return parts.join(' ');
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

  // Central bank interest rates are not a World Bank indicator. A question about
  // one (and not also about an indicator named in its own param) is answered
  // from the central bank itself.
  const allText = [countryRaw, indicatorRaw, freeText].filter((v) => typeof v === 'string').join(' ').slice(0, MAX_INPUT_CHARS);
  if (POLICY_RATE_RE.test(allText) && !(typeof indicatorRaw === 'string' && resolveIndicatorCode(indicatorRaw))) {
    const region = resolvePolicyRegion(allText);
    if (!region) {
      return respondUnusableInput(
        res,
        `Central bank interest rates are covered for ${Object.values(POLICY_REGIONS).join(', ')}. Name one of them, for example "the Fed rate" or "the ECB deposit rate".`,
      );
    }
    try {
      const rate = await fetchPolicyRate(region);
      return res.json({
        status: 'ok',
        summary: policyRateSummary(rate),
        confidence: 0.9,
        canonical: ['macro-economic-indicator', 'policy-rate', region.toLowerCase()].join(':'),
        country: POLICY_REGIONS[region],
        indicator: `${rate.bank} ${rate.rate_name}`,
        value: rate.percent,
        unit: 'percent',
        as_of: rate.as_of,
        policy_rate: rate,
        source: rate.bank,
        checked_at: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof PolicyRateUpstreamError) {
        return res.json({
          status: 'unavailable',
          verdict: 'unavailable',
          summary: `The ${POLICY_REGIONS[region]} central bank rate feed did not answer at request time, so no rate is stated rather than an old one guessed.`,
          confidence: 0.3,
          country: POLICY_REGIONS[region],
          value: null,
          unit: 'percent',
          error: err.message,
          checked_at: new Date().toISOString(),
        });
      }
      throw err;
    }
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
      // Still a 200 with every field named: a 5xx is booked as a failed answer.
      return res.json({
        status: 'unavailable',
        verdict: 'unavailable',
        summary: `Neither the World Bank nor the IMF statistics API answered at request time, so no ${indicatorLabel(indicatorCode)} figure for ${countryCode} is stated rather than one guessed.`,
        confidence: 0.3,
        country_code: countryCode,
        indicator: indicatorLabel(indicatorCode),
        indicator_code: indicatorCode,
        year: null,
        value: null,
        unit: indicatorUnit(indicatorCode),
        source: 'World Bank, IMF',
        error: err.message,
        checked_at: new Date().toISOString(),
      });
    }
    throw err;
  }

  const askedYear = (candidateTexts.join(' ').match(/\b(19[6-9]\d|20[0-3]\d)\b/) ?? [])[1] ?? null;
  res.json({
    status: 'ok',
    verdict: 'found',
    summary: summarize(result, askedYear),
    confidence: result.stale ? 0.8 : 0.95,
    canonical: ['macro-economic-indicator', result.countryCode.toLowerCase(), result.indicatorCode.toLowerCase()].join(':'),
    country: result.country,
    country_code: result.countryCode,
    indicator: result.indicator,
    indicator_code: result.indicatorCode,
    year: result.year,
    value: result.value,
    unit: result.unit,
    frequency: 'annual',
    history: result.history ?? null,
    projection: result.projection ?? null,
    source: result.source ?? 'World Bank',
    source_url: result.sourceUrl ?? null,
    attribution: result.source === 'IMF World Economic Outlook' ? 'IMF World Economic Outlook (imf.org DataMapper API).' : WORLD_BANK_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleMacroEconomicIndicator(req, res));
router.post('/', (req, res) => handleMacroEconomicIndicator(req, res));

export default router;
