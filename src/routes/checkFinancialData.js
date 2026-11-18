// FINANCIAL_DATA signal endpoint. Company fundamentals (revenue, net income,
// assets, equity, cash, debt, per-share earnings, share count) for a US-listed
// company, from the figures the company itself filed with the SEC. Accepts a
// company name or ticker as a param or inside a whole question. With no metric
// named it answers a short snapshot; "quarter" in the question switches from
// the latest annual report to the latest quarterly one.

import { Router } from 'express';
import {
  resolveCompany, resolveMetric, resolveMetrics, resolvePeriod, resolveTarget, fetchMetric, formatValue,
  FinancialUpstreamError, SEC_ATTRIBUTION,
} from '../lib/financialData.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';
import { searchWeb } from '../lib/webSearch.js';
import { citationsFrom } from './checkQuestionAnswering.js';

const router = Router();

const COMPANY_PARAM_KEYS = ['company', 'company_name', 'ticker', 'symbol', 'name', 'entity', 'issuer'];
const METRIC_PARAM_KEYS = ['metric', 'field', 'item', 'measure', 'statistic', 'indicator', 'data_point'];
const FREE_TEXT_KEYS = ['query', 'q', 'question', 'text', 'input', 'search'];
const MAX_INPUT_CHARS = 400;
const SNAPSHOT = ['revenue', 'net_income', 'total_assets', 'equity'];

const periodWords = (m, period) => {
  if (m.fiscal_period === 'FY' || period === 'annual') return `the fiscal year ended ${m.period_end}`;
  return `the quarter ended ${m.period_end}`;
};

const targetWords = (t) => `${t.quarter ? `Q${t.quarter} ` : ''}${t.fiscal ? 'fiscal ' : ''}${t.year}`;

// Market questions about coins, tokens and DeFi pools. A company name search
// on these finds the wrong filer (a WETH/USDC pool question matched Pool
// Corp), so they go to a live web search instead.
const CRYPTO_QUESTION = /\b(crypto|bitcoin|btc|wbtc|ethereum|eth|ether|weth|usdc|usdt|stablecoin|solana|token|tokens|defi|tvl|total value locked|uniswap|on-?chain|liquidity pool|order book)\b/i;

// A live web answer with its sources, for what SEC filings do not hold:
// crypto markets, forecasts, products and non-US companies.
async function webAnswer(res, question, why) {
  let out = null;
  try {
    out = await searchWeb(question, { topic: 'finance', budgetMs: 15_000, maxResults: 5 });
  } catch {
    out = null;
  }
  if (!out?.answer) return false;
  const citations = citationsFrom(out.results);
  res.json({
    status: 'ok',
    summary: String(out.answer).trim(),
    found: true,
    confidence: 0.75,
    source: 'live web search',
    ...(citations.length ? { citations } : {}),
    method: `${why} so this was answered from a live web search of current sources, listed under citations.`,
  });
  return true;
}

async function handleFinancialData(req, res) {
  const params = (req.method === 'GET' ? req.query : req.body) ?? {};
  const slice = (v) => (typeof v === 'string' ? v.slice(0, MAX_INPUT_CHARS) : v);
  const companyRaw = slice(firstUsableValue(...COMPANY_PARAM_KEYS.map((k) => params[k])));
  const metricRaw = slice(firstUsableValue(...METRIC_PARAM_KEYS.map((k) => params[k])));
  const freeText = slice(firstUsableValue(...FREE_TEXT_KEYS.map((k) => params[k])));

  if (!companyRaw && !freeText) {
    return respondUnusableInput(
      res,
      'I cannot look up company financials because no company was supplied. Pass a company name or ticker (for example Apple or AAPL) and optionally a metric such as revenue, net income or total assets.',
    );
  }

  const question = String(freeText ?? '');
  if (!companyRaw && CRYPTO_QUESTION.test(question)) {
    if (await webAnswer(res, question, 'This is a crypto market question that company SEC filings do not cover,')) return;
    // A company name search would only find an unrelated filer here.
    return res.json({
      status: 'unavailable',
      summary: 'This is a crypto market question, which company SEC filings do not cover, and the live market sources did not answer in time, so no figure is stated rather than one guessed. Retry shortly.',
      confidence: 0.2,
    });
  }

  let company = null;
  try {
    for (const text of [companyRaw, freeText]) {
      if (!company && typeof text === 'string' && text.trim()) company = await resolveCompany(text);
    }
  } catch (err) {
    if (err instanceof FinancialUpstreamError) return upstreamError(res, err);
    throw err;
  }

  const echo = String(companyRaw ?? freeText ?? '');
  if (!company) {
    if (question && await webAnswer(res, question, 'No US SEC filer matched the question,')) return;
    return res.json({
      status: 'not_found',
      summary: `No US SEC filer matching ${quoteParam(echo)} was found. This lookup covers companies listed in the United States that file with the SEC, so a private or non-US company will not appear.`,
      confidence: 0.3,
      canonical: ['financial-data', 'unknown-company'].join(':'),
      checked_at: new Date().toISOString(),
    });
  }

  const named = [...new Set([...resolveMetrics(metricRaw), ...resolveMetrics(freeText)])];
  const metricKey = named[0] ?? resolveMetric(companyRaw);
  const period = resolvePeriod([metricRaw, freeText, companyRaw].filter(Boolean).join(' '));
  const target = resolveTarget([metricRaw, freeText].filter(Boolean).join(' '));
  const keys = named.length > 1 ? named : metricKey ? [metricKey] : SNAPSHOT;

  let metrics;
  let missedTarget = false;
  try {
    metrics = (await Promise.all(keys.map((k) => fetchMetric(company, k, period, target)))).filter(Boolean);
    // The asked period is not on file (not yet reported, or before the
    // company's XBRL filings start): give the latest one and say so.
    if (!metrics.length && target) {
      missedTarget = true;
      metrics = (await Promise.all(keys.map((k) => fetchMetric(company, k, period)))).filter(Boolean);
    }
  } catch (err) {
    if (err instanceof FinancialUpstreamError) return upstreamError(res, err);
    throw err;
  }

  const who = `${company.name} (${company.ticker})`;
  if (!metrics.length) {
    return res.json({
      status: 'not_found',
      summary: `${who} has no ${metricKey ? 'reported ' + keys[0].replace(/_/g, ' ') : 'financial figures'} in its SEC ${period === 'quarter' ? 'quarterly' : 'annual'} filings that this lookup could read.`,
      confidence: 0.3,
      canonical: ['financial-data', String(company.cik), metricKey ?? 'snapshot', period].join(':'),
      company: company.name,
      ticker: company.ticker,
      cik: company.cik,
      checked_at: new Date().toISOString(),
    });
  }

  const head = metrics[0];
  const several = named.length > 1;
  const samePeriod = metrics.every((m) => m.period_end === head.period_end && m.form === head.form);
  const summary = several && samePeriod
    ? `${who} reported ${metrics.map((m) => `${m.label} of ${formatValue(m.value, m.unit)}`).join(' and ')} for ${periodWords(head, period)}, according to its ${head.form} filed ${head.filed ?? 'on the SEC record'} (SEC EDGAR).`
    : several
      ? `${who}, from its SEC EDGAR filings: ${metrics.map((m) => `${m.label} ${formatValue(m.value, m.unit)} for ${periodWords(m, period)} (${m.form} filed ${m.filed ?? 'on the SEC record'})`).join('; ')}.`
    : metricKey
    ? `${who} reported ${head.label} of ${formatValue(head.value, head.unit)} for ${periodWords(head, period)}, according to its ${head.form} filed ${head.filed ?? 'on the SEC record'} (SEC EDGAR).`
    : `${who}, from its ${head.form} filed ${head.filed ?? 'on the SEC record'} (SEC EDGAR), for ${periodWords(head, period)}: `
      + `${metrics.map((m) => `${m.label} ${formatValue(m.value, m.unit)}`).join(', ')}.`;
  const note = missedTarget ? ` No ${targetWords(target)} figure is in its SEC filings, so this is the latest one filed.` : '';

  res.json({
    status: 'ok',
    summary: summary + note,
    confidence: missedTarget ? 0.6 : 0.9,
    canonical: ['financial-data', String(company.cik), metricKey ?? 'snapshot', period].join(':'),
    company: company.name,
    ticker: company.ticker,
    cik: company.cik,
    metric: several ? named.join(',') : metricKey ?? 'snapshot',
    period,
    ...(target ? { requested_period: targetWords(target) } : {}),
    value: metricKey && !several ? head.value : null,
    unit: metricKey && !several ? head.unit : null,
    period_end: head.period_end,
    figures: metrics,
    source: 'SEC EDGAR',
    attribution: SEC_ATTRIBUTION,
    checked_at: new Date().toISOString(),
  });
}

function upstreamError(res, err) {
  return res.status(502).json({
    status: 'error',
    summary: 'SEC EDGAR is temporarily unavailable, so the financial figures could not be checked right now. Retry shortly.',
    confidence: 0,
    error: err.message,
  });
}

router.get('/', (req, res) => handleFinancialData(req, res));
router.post('/', (req, res) => handleFinancialData(req, res));

export default router;
