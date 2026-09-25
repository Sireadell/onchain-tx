// ADAPTED from telegraph-forensics-miner/src/app.js (Miner #1) — same
// reasoning applies here: no payment gate of our own (Telegraph's dispatcher
// handles that upstream), rate limiting still matters because this endpoint
// spends our own Ankr quota on every call and the HTTP endpoint itself is a
// plain public URL underneath the dispatcher.

import express from 'express';
import rateLimit from 'express-rate-limit';
import healthRouter from './routes/health.js';
import checkTxRouter from './routes/checkTx.js';
import checkGasPriceRouter from './routes/checkGasPrice.js';
import checkWalletBalanceRouter from './routes/checkWalletBalance.js';
import checkTokenHoldersRouter from './routes/checkTokenHolders.js';
import checkTvlRouter from './routes/checkTvl.js';
import checkCryptoPriceRouter from './routes/checkCryptoPrice.js';
import checkStockPriceRouter from './routes/checkStockPrice.js';
import checkSslVerificationRouter from './routes/checkSslVerification.js';
import checkWeatherForecastRouter from './routes/checkWeatherForecast.js';
import checkStormAlertRouter from './routes/checkStormAlert.js';
import checkIpGeolocationRouter from './routes/checkIpGeolocation.js';
import checkAcademicSearchRouter from './routes/checkAcademicSearch.js';
import checkWebSearchRouter from './routes/checkWebSearch.js';
import checkContentExtractionRouter from './routes/checkContentExtraction.js';
import checkTextClassificationRouter from './routes/checkTextClassification.js';
import checkTextGenerationRouter from './routes/checkTextGeneration.js';
import checkLanguageGenerationRouter from './routes/checkLanguageGeneration.js';
import checkResearchSynthesisRouter from './routes/checkResearchSynthesis.js';
import checkCrossChainStateVerifyRouter from './routes/checkCrossChainStateVerify.js';
import checkEventOutcomeResolutionRouter from './routes/checkEventOutcomeResolution.js';
import checkWeatherCheckRouter from './routes/checkWeatherCheck.js';
import checkLanguageTranslationRouter from './routes/checkLanguageTranslation.js';
import checkChatCompletionRouter from './routes/checkChatCompletion.js';
import checkNewsSearchRouter from './routes/checkNewsSearch.js';
import checkNewsHeadlinesRouter from './routes/checkNewsHeadlines.js';
import checkFactCheckRouter from './routes/checkFactCheck.js';
import checkSentimentAnalysisRouter from './routes/checkSentimentAnalysis.js';
import checkContentModerationRouter from './routes/checkContentModeration.js';
import checkCveLookupRouter from './routes/checkCveLookup.js';
import checkTelegraphKnowledgeRouter from './routes/checkTelegraphKnowledge.js';
import checkTextSummarizationRouter from './routes/checkTextSummarization.js';
import checkChatbotConversationRouter from './routes/checkChatbotConversation.js';
import checkSemanticSimilarityRouter from './routes/checkSemanticSimilarity.js';
import checkGrammarSpellCheckRouter from './routes/checkGrammarSpellCheck.js';
import checkAiTextDetectionRouter from './routes/checkAiTextDetection.js';
import checkResearchQueryRouter from './routes/checkResearchQuery.js';
import checkThreatIntelligenceRouter from './routes/checkThreatIntelligence.js';
import checkPackageStatusRouter from './routes/checkPackageStatus.js';
import checkUrlScanRouter from './routes/checkUrlScan.js';
import checkCurrencyExchangeRouter from './routes/checkCurrencyExchange.js';
import checkFxNowRouter from './routes/checkFxNow.js';
import checkTokenTotalSupplyRouter from './routes/checkTokenTotalSupply.js';
import checkCorporateRegistryRouter from './routes/checkCorporateRegistry.js';
import checkEmailSecurityRouter from './routes/checkEmailSecurity.js';
import checkMiningHashpriceRouter from './routes/checkMiningHashprice.js';
import {
  securityReviewRouter, llmOutputEvaluationRouter, contractObligationAuditRouter,
  codeGenerationRouter, codeReviewRouter, textAuthenticityRouter,
} from './routes/llmIntents.js';
import checkSanctionsScreeningMatchRouter from './routes/checkSanctionsScreeningMatch.js';
import checkVulnerabilityTriageRouter from './routes/checkVulnerabilityTriage.js';
import checkSportsScoreRouter from './routes/checkSportsScore.js';
import checkGameResultRouter from './routes/checkGameResult.js';
import checkRouteEtaRouter from './routes/checkRouteEta.js';
import checkRegulatoryFilingMonitorRouter from './routes/checkRegulatoryFilingMonitor.js';
import checkCreditScoreVerifyRouter from './routes/checkCreditScoreVerify.js';
import checkMacroEconomicIndicatorRouter from './routes/checkMacroEconomicIndicator.js';
import checkWeatherForecastVerifyRouter from './routes/checkWeatherForecastVerify.js';
import checkCustomerTicketResolutionRouter from './routes/checkCustomerTicketResolution.js';
import checkReturnPolicyVerifyRouter from './routes/checkReturnPolicyVerify.js';
import checkTaskExecutionQualityRouter from './routes/checkTaskExecutionQuality.js';
import checkCarrierServiceabilityRouter from './routes/checkCarrierServiceability.js';
import checkDeliveryWindowVerifyRouter from './routes/checkDeliveryWindowVerify.js';
import checkPaymentMethodVerifyRouter from './routes/checkPaymentMethodVerify.js';
import checkInvoiceLedgerReconcileRouter from './routes/checkInvoiceLedgerReconcile.js';
import checkUrlSafeRouter from './routes/checkUrlSafe.js';
import checkMalwareDetectionRouter from './routes/checkMalwareDetection.js';
import checkDnsRecordsRouter from './routes/checkDnsRecords.js';
import checkThreatIpReputationRouter from './routes/checkThreatIpReputation.js';
import sentinelFraudRouter from './routes/sentinelFraud.js';
import { misrouteWatchMiddleware, extractRequestText } from './lib/misrouteWatch.js';
import { createMisrouteHandoffMiddleware } from './lib/misrouteHandoff.js';
import { createRefusalFallbackMiddleware } from './lib/refusalFallback.js';

// Each route has its own bucket. The default allows dispatcher bursts while
// the provider-specific clients still enforce their own tighter quotas.
function signalRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.SIGNAL_RATE_LIMIT_PER_MIN) || 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many requests; slow down and try again shortly' },
  });
}

const checkTxRateLimit = signalRateLimit();
const checkGasPriceRateLimit = signalRateLimit();
const checkWalletBalanceRateLimit = signalRateLimit();
const checkTokenHoldersRateLimit = signalRateLimit();
const checkTvlRateLimit = signalRateLimit();
const checkCryptoPriceRateLimit = signalRateLimit();
const checkStockPriceRateLimit = signalRateLimit();
const checkSslVerificationRateLimit = signalRateLimit();
const checkWeatherForecastRateLimit = signalRateLimit();
const checkStormAlertRateLimit = signalRateLimit();
const checkIpGeolocationRateLimit = signalRateLimit();
const checkAcademicSearchRateLimit = signalRateLimit();
const checkWebSearchRateLimit = signalRateLimit();
const checkContentExtractionRateLimit = signalRateLimit();
const checkTextClassificationRateLimit = signalRateLimit();
const checkTextGenerationRateLimit = signalRateLimit();
const checkLanguageGenerationRateLimit = signalRateLimit();
const checkResearchSynthesisRateLimit = signalRateLimit();
const checkCrossChainStateVerifyRateLimit = signalRateLimit();
const checkEventOutcomeResolutionRateLimit = signalRateLimit();
const checkWeatherCheckRateLimit = signalRateLimit();
const checkLanguageTranslationRateLimit = signalRateLimit();
const checkChatCompletionRateLimit = signalRateLimit();
const checkNewsSearchRateLimit = signalRateLimit();
const checkNewsHeadlinesRateLimit = signalRateLimit();
const checkFactCheckRateLimit = signalRateLimit();
const checkSentimentAnalysisRateLimit = signalRateLimit();
const checkContentModerationRateLimit = signalRateLimit();
const checkCveLookupRateLimit = signalRateLimit();
const checkTelegraphKnowledgeRateLimit = signalRateLimit();
const checkTextSummarizationRateLimit = signalRateLimit();
const checkChatbotConversationRateLimit = signalRateLimit();
const checkSemanticSimilarityRateLimit = signalRateLimit();
const checkGrammarSpellCheckRateLimit = signalRateLimit();
const checkAiTextDetectionRateLimit = signalRateLimit();
const checkResearchQueryRateLimit = signalRateLimit();
const checkThreatIntelligenceRateLimit = signalRateLimit();
const checkPackageStatusRateLimit = signalRateLimit();
const checkUrlScanRateLimit = signalRateLimit();
const checkCurrencyExchangeRateLimit = signalRateLimit();
const checkFxNowRateLimit = signalRateLimit();
const batch5RateLimit = signalRateLimit();
const checkSanctionsScreeningMatchRateLimit = signalRateLimit();
const checkVulnerabilityTriageRateLimit = signalRateLimit();
const checkSportsScoreRateLimit = signalRateLimit();
const checkGameResultRateLimit = signalRateLimit();
const checkRouteEtaRateLimit = signalRateLimit();
const checkRegulatoryFilingMonitorRateLimit = signalRateLimit();
const checkCreditScoreVerifyRateLimit = signalRateLimit();
const checkMacroEconomicIndicatorRateLimit = signalRateLimit();
const checkWeatherForecastVerifyRateLimit = signalRateLimit();
const checkCustomerTicketResolutionRateLimit = signalRateLimit();
const checkReturnPolicyVerifyRateLimit = signalRateLimit();
const checkTaskExecutionQualityRateLimit = signalRateLimit();
const checkCarrierServiceabilityRateLimit = signalRateLimit();
const checkDeliveryWindowVerifyRateLimit = signalRateLimit();
const checkPaymentMethodVerifyRateLimit = signalRateLimit();
const checkInvoiceLedgerReconcileRateLimit = signalRateLimit();
const checkUrlSafeRateLimit = signalRateLimit();
const checkMalwareDetectionRateLimit = signalRateLimit();
const checkDnsRecordsRateLimit = signalRateLimit();
const checkThreatIpReputationRateLimit = signalRateLimit();
const sentinelFraudRateLimit = signalRateLimit();
const misrouteHandoffMiddleware = createMisrouteHandoffMiddleware({
  transaction: checkTxRateLimit,
  walletBalance: checkWalletBalanceRateLimit,
  tokenHolders: checkTokenHoldersRateLimit,
  ipGeolocation: checkIpGeolocationRateLimit,
  fraud: sentinelFraudRateLimit,
});
const refusalFallbackMiddleware = createRefusalFallbackMiddleware();

// Logs every request as it arrives and again when it finishes, to stdout
// (Render captures this in its dashboard logs, no extra infra needed). Added
// 2026-08-25 after being unable to tell, after the fact, whether blank
// grading answers (TVL/holders/price scored with an empty miner_answer) were
// caused by the server never receiving the request, timing out mid-call, or
// something else — the explorer's scoring history doesn't record that.
// Placed before rate limiting so a rejected request still gets logged.
//
// Extended 2026-09-02 to also log the question text and the final response
// body, so a specific question ("did we get asked X") and its answer can be
// confirmed after the fact instead of just the path and status code. Mounted
// after express.json() so req.body is parsed, and wraps res.json first (so
// it unwraps last) so it captures the body after answerFieldMiddleware,
// misrouteWatchMiddleware, and refusalFallbackMiddleware have all had their
// say — the same JSON the caller actually receives.
const MAX_LOGGED_BODY_CHARS = 500;
const requestLogMiddleware = (req, res, next) => {
  const start = Date.now();
  const question = extractRequestText(req);
  console.log(`[req] ${new Date().toISOString()} ${req.method} ${req.originalUrl}${question ? ` question=${JSON.stringify(question)}` : ''}`);

  const sendJson = res.json.bind(res);
  let responseBody;
  res.json = (body) => {
    responseBody = body;
    return sendJson(body);
  };

  res.on('finish', () => {
    let answer = '';
    if (responseBody !== undefined) {
      const serialized = JSON.stringify(responseBody);
      answer = ` answer=${serialized.length > MAX_LOGGED_BODY_CHARS ? `${serialized.slice(0, MAX_LOGGED_BODY_CHARS)}...` : serialized}`;
    }
    console.log(`[res] ${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)${answer}`);
  });
  next();
};

const corsMiddleware = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '3');
    return res.sendStatus(204);
  }
  next();
};

// The Telegraph engine grades exactly ONE field of the response body — the
// one named by signal_mapping.label_field in miner.yaml. That field was
// `status`, whose value is a single word: "confirmed", "ok", "LOW".
//
// Measured 2026-08-30 by running the live ONCHAIN_TX_LOOKUP grading module
// (champion #642) over this miner's own output for the same transaction,
// against the same ground truth:
//
//   "confirmed"          (the `status` we submit)  -> 0.0050
//   the `summary` sentence (computed, not submitted) -> 0.9982
//
// So the answer that wins was already being produced and then thrown away
// in favour of a single word. label_field now points at `answer`, and this
// fills `answer` in from `summary` for every route that does not set one.
//
// The fraud routes already return their own, richer `answer` and are left
// untouched: FRAUD_DETECTION is the only intent already scoring ~0.99, and
// it is the one endpoint with no `status` field at all — which is very
// likely why it alone escaped this bug.
const answerFieldMiddleware = (req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (
      body && typeof body === 'object' && !Array.isArray(body)
      && body.answer === undefined
      && typeof body.summary === 'string' && body.summary.trim()
    ) {
      return sendJson({ ...body, answer: body.summary });
    }
    return sendJson(body);
  };
  next();
};

// Express 4 only sends an error to the four-argument error handler when a
// handler throws synchronously. Every route here is async, and a rejected
// promise from an async handler is not passed on at all: the request just
// hangs until the caller gives up. So the error middleware at the bottom of
// buildApp() would never see the exact class of failure it exists for
// unless rejections are forwarded to it explicitly. This walks a router's
// handlers once, at startup, and wraps each one so a returned promise
// rejects into next(err). Same effect as the express-async-errors package,
// without adding a dependency, and it runs before any request is served so
// there's no per-request cost.
export function forwardAsyncErrors(router) {
  const stack = router?.stack;
  if (!Array.isArray(stack)) return router;
  for (const layer of stack) {
    const handlers = layer.route ? layer.route.stack : [layer];
    for (const entry of handlers) {
      const handle = entry.handle;
      if (typeof handle !== 'function' || handle.length >= 4 || handle.__asyncWrapped) continue;
      const wrapped = function (req, res, next) {
        try {
          const out = handle.call(this, req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
          return out;
        } catch (err) {
          return next(err);
        }
      };
      wrapped.__asyncWrapped = true;
      entry.handle = wrapped;
    }
    if (layer.handle?.stack) forwardAsyncErrors(layer.handle);
  }
  return router;
}

// Exported so a test can exercise the real handler, not a copy of it.
// eslint-disable-next-line no-unused-vars -- Express only treats a
// four-argument function as an error handler, so `next` has to stay.
export function errorHandler(err, req, res, next) {
  console.error(`unhandled route error: ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(500).json({
    status: 'error',
    summary: 'This request could not be answered because of an unexpected internal error.',
    confidence: 0,
    error: err?.message ?? String(err),
  });
}

export function buildApp() {
  const app = express();
  // Same reasoning as Miner #1: exactly one proxy hop on Render, `1` not
  // `true` so a caller can't spoof X-Forwarded-For to collapse the rate
  // limiter into one shared bucket.
  app.set('trust proxy', 1);
  app.use(corsMiddleware);
  app.use(express.json());
  app.use(requestLogMiddleware);
  app.use(answerFieldMiddleware);
  app.use(misrouteWatchMiddleware);
  // Mounted after the watcher so the watcher records what the caller was
  // actually sent, and after answerFieldMiddleware so a rescued answer
  // passes back out through the same chain a route's own answer does.
  app.use(refusalFallbackMiddleware);

  app.use('/health', forwardAsyncErrors(healthRouter));
  app.use('/check-tx', checkTxRateLimit, misrouteHandoffMiddleware, forwardAsyncErrors(checkTxRouter));
  app.use('/gas-price', checkGasPriceRateLimit, forwardAsyncErrors(checkGasPriceRouter));
  app.use('/wallet-balance', checkWalletBalanceRateLimit, misrouteHandoffMiddleware, forwardAsyncErrors(checkWalletBalanceRouter));
  app.use('/token-holders', checkTokenHoldersRateLimit, misrouteHandoffMiddleware, forwardAsyncErrors(checkTokenHoldersRouter));
  app.use('/tvl', checkTvlRateLimit, forwardAsyncErrors(checkTvlRouter));
  app.use('/crypto-price', checkCryptoPriceRateLimit, misrouteHandoffMiddleware, forwardAsyncErrors(checkCryptoPriceRouter));
  app.use('/stock-price', checkStockPriceRateLimit, misrouteHandoffMiddleware, forwardAsyncErrors(checkStockPriceRouter));
  app.use('/ssl-check', checkSslVerificationRateLimit, misrouteHandoffMiddleware, forwardAsyncErrors(checkSslVerificationRouter));
  app.use('/weather-forecast', checkWeatherForecastRateLimit, forwardAsyncErrors(checkWeatherForecastRouter));
  app.use('/storm-alert', checkStormAlertRateLimit, forwardAsyncErrors(checkStormAlertRouter));
  app.use('/ip-geolocate', checkIpGeolocationRateLimit, forwardAsyncErrors(checkIpGeolocationRouter));
  app.use('/academic-search', checkAcademicSearchRateLimit, forwardAsyncErrors(checkAcademicSearchRouter));
  app.use('/web-search', checkWebSearchRateLimit, forwardAsyncErrors(checkWebSearchRouter));
  app.use('/content-extract', checkContentExtractionRateLimit, forwardAsyncErrors(checkContentExtractionRouter));
  app.use('/text-classify', checkTextClassificationRateLimit, forwardAsyncErrors(checkTextClassificationRouter));
  app.use('/text-generate', checkTextGenerationRateLimit, forwardAsyncErrors(checkTextGenerationRouter));
  app.use('/language-generate', checkLanguageGenerationRateLimit, forwardAsyncErrors(checkLanguageGenerationRouter));
  app.use('/research-synthesis', checkResearchSynthesisRateLimit, forwardAsyncErrors(checkResearchSynthesisRouter));
  app.use('/cross-chain-state', checkCrossChainStateVerifyRateLimit, forwardAsyncErrors(checkCrossChainStateVerifyRouter));
  app.use('/event-outcome', checkEventOutcomeResolutionRateLimit, forwardAsyncErrors(checkEventOutcomeResolutionRouter));
  app.use('/weather-check', checkWeatherCheckRateLimit, forwardAsyncErrors(checkWeatherCheckRouter));
  app.use('/language-translate', checkLanguageTranslationRateLimit, forwardAsyncErrors(checkLanguageTranslationRouter));
  app.use('/chat-complete', checkChatCompletionRateLimit, forwardAsyncErrors(checkChatCompletionRouter));
  app.use('/news-search', checkNewsSearchRateLimit, forwardAsyncErrors(checkNewsSearchRouter));
  app.use('/news-headlines', checkNewsHeadlinesRateLimit, forwardAsyncErrors(checkNewsHeadlinesRouter));
  app.use('/fact-check', checkFactCheckRateLimit, forwardAsyncErrors(checkFactCheckRouter));
  app.use('/sentiment-analyze', checkSentimentAnalysisRateLimit, forwardAsyncErrors(checkSentimentAnalysisRouter));
  app.use('/content-moderate', checkContentModerationRateLimit, forwardAsyncErrors(checkContentModerationRouter));
  app.use('/cve-lookup', checkCveLookupRateLimit, forwardAsyncErrors(checkCveLookupRouter));
  app.use('/telegraph-knowledge', checkTelegraphKnowledgeRateLimit, forwardAsyncErrors(checkTelegraphKnowledgeRouter));
  app.use('/text-summarize', checkTextSummarizationRateLimit, forwardAsyncErrors(checkTextSummarizationRouter));
  app.use('/chatbot-conversation', checkChatbotConversationRateLimit, forwardAsyncErrors(checkChatbotConversationRouter));
  app.use('/semantic-similarity', checkSemanticSimilarityRateLimit, forwardAsyncErrors(checkSemanticSimilarityRouter));
  app.use('/grammar-spell-check', checkGrammarSpellCheckRateLimit, forwardAsyncErrors(checkGrammarSpellCheckRouter));
  app.use('/ai-text-detect', checkAiTextDetectionRateLimit, forwardAsyncErrors(checkAiTextDetectionRouter));
  app.use('/research-query', checkResearchQueryRateLimit, forwardAsyncErrors(checkResearchQueryRouter));
  app.use('/threat-intelligence', checkThreatIntelligenceRateLimit, forwardAsyncErrors(checkThreatIntelligenceRouter));
  app.use('/package-status', checkPackageStatusRateLimit, forwardAsyncErrors(checkPackageStatusRouter));
  app.use('/url-scan', checkUrlScanRateLimit, forwardAsyncErrors(checkUrlScanRouter));
  app.use('/currency-exchange', checkCurrencyExchangeRateLimit, forwardAsyncErrors(checkCurrencyExchangeRouter));
  app.use('/fx-now', checkFxNowRateLimit, forwardAsyncErrors(checkFxNowRouter));
  app.use('/token-total-supply', batch5RateLimit, forwardAsyncErrors(checkTokenTotalSupplyRouter));
  app.use('/corporate-registry', batch5RateLimit, forwardAsyncErrors(checkCorporateRegistryRouter));
  app.use('/email-security', batch5RateLimit, forwardAsyncErrors(checkEmailSecurityRouter));
  app.use('/mining-hashprice', batch5RateLimit, forwardAsyncErrors(checkMiningHashpriceRouter));
  app.use('/security-review', batch5RateLimit, forwardAsyncErrors(securityReviewRouter));
  app.use('/llm-output-evaluation', batch5RateLimit, forwardAsyncErrors(llmOutputEvaluationRouter));
  app.use('/contract-obligation-audit', batch5RateLimit, forwardAsyncErrors(contractObligationAuditRouter));
  app.use('/code-generation', batch5RateLimit, forwardAsyncErrors(codeGenerationRouter));
  app.use('/code-review', batch5RateLimit, forwardAsyncErrors(codeReviewRouter));
  app.use('/text-authenticity', batch5RateLimit, forwardAsyncErrors(textAuthenticityRouter));
  app.use('/sanctions-screening', checkSanctionsScreeningMatchRateLimit, forwardAsyncErrors(checkSanctionsScreeningMatchRouter));
  app.use('/vulnerability-triage', checkVulnerabilityTriageRateLimit, forwardAsyncErrors(checkVulnerabilityTriageRouter));
  app.use('/sports-score', checkSportsScoreRateLimit, forwardAsyncErrors(checkSportsScoreRouter));
  app.use('/game-result', checkGameResultRateLimit, forwardAsyncErrors(checkGameResultRouter));
  app.use('/route-eta', checkRouteEtaRateLimit, forwardAsyncErrors(checkRouteEtaRouter));
  app.use('/regulatory-filing-monitor', checkRegulatoryFilingMonitorRateLimit, forwardAsyncErrors(checkRegulatoryFilingMonitorRouter));
  app.use('/credit-score-verify', checkCreditScoreVerifyRateLimit, forwardAsyncErrors(checkCreditScoreVerifyRouter));
  app.use('/macro-economic-indicator', checkMacroEconomicIndicatorRateLimit, forwardAsyncErrors(checkMacroEconomicIndicatorRouter));
  app.use('/weather-forecast-verify', checkWeatherForecastVerifyRateLimit, forwardAsyncErrors(checkWeatherForecastVerifyRouter));
  app.use('/customer-ticket-resolution', checkCustomerTicketResolutionRateLimit, forwardAsyncErrors(checkCustomerTicketResolutionRouter));
  app.use('/return-policy-verify', checkReturnPolicyVerifyRateLimit, forwardAsyncErrors(checkReturnPolicyVerifyRouter));
  app.use('/task-execution-quality', checkTaskExecutionQualityRateLimit, forwardAsyncErrors(checkTaskExecutionQualityRouter));
  app.use('/carrier-serviceability', checkCarrierServiceabilityRateLimit, forwardAsyncErrors(checkCarrierServiceabilityRouter));
  app.use('/delivery-window-verify', checkDeliveryWindowVerifyRateLimit, forwardAsyncErrors(checkDeliveryWindowVerifyRouter));
  app.use('/payment-method-verify', checkPaymentMethodVerifyRateLimit, forwardAsyncErrors(checkPaymentMethodVerifyRouter));
  app.use('/invoice-ledger-reconcile', checkInvoiceLedgerReconcileRateLimit, forwardAsyncErrors(checkInvoiceLedgerReconcileRouter));
  app.use('/url-safe', checkUrlSafeRateLimit, forwardAsyncErrors(checkUrlSafeRouter));
  app.use('/malware-detection', checkMalwareDetectionRateLimit, forwardAsyncErrors(checkMalwareDetectionRouter));
  app.use('/dns-check', checkDnsRecordsRateLimit, forwardAsyncErrors(checkDnsRecordsRouter));
  app.use('/threat-ip-reputation', checkThreatIpReputationRateLimit, forwardAsyncErrors(checkThreatIpReputationRouter));
  app.use('/fraud-query', sentinelFraudRateLimit, misrouteHandoffMiddleware);
  app.use('/assess-wallet', sentinelFraudRateLimit, misrouteHandoffMiddleware);
  app.use('/', forwardAsyncErrors(sentinelFraudRouter));

  // Last middleware in the chain, deliberately. Express only routes an error
  // to a four-argument handler, and until now there was none anywhere in the
  // app, so any exception a route threw left the request hanging with no
  // response ever sent. Telegraph's grader books that as a timeout rather
  // than an error, which hides the cause completely: the BigInt("0x") crash
  // took three graded questions down before anyone could see why. Answer
  // with a real JSON error instead, in the same shape every route uses, so a
  // future uncaught bug costs one visible failed answer and not a silent
  // one.
  app.use(errorHandler);

  return app;
}
