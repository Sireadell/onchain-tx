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
import sentinelFraudRouter from './routes/sentinelFraud.js';
import { misrouteWatchMiddleware } from './lib/misrouteWatch.js';
import { createMisrouteHandoffMiddleware } from './lib/misrouteHandoff.js';

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
const sentinelFraudRateLimit = signalRateLimit();
const misrouteHandoffMiddleware = createMisrouteHandoffMiddleware({
  transaction: checkTxRateLimit,
  walletBalance: checkWalletBalanceRateLimit,
  tokenHolders: checkTokenHoldersRateLimit,
  ipGeolocation: checkIpGeolocationRateLimit,
});

// Logs every request as it arrives and again when it finishes, to stdout
// (Render captures this in its dashboard logs, no extra infra needed). Added
// 2026-08-25 after being unable to tell, after the fact, whether blank
// grading answers (TVL/holders/price scored with an empty miner_answer) were
// caused by the server never receiving the request, timing out mid-call, or
// something else — the explorer's scoring history doesn't record that.
// Placed before rate limiting so a rejected request still gets logged.
const requestLogMiddleware = (req, res, next) => {
  const start = Date.now();
  console.log(`[req] ${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    console.log(`[res] ${new Date().toISOString()} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
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

export function buildApp() {
  const app = express();
  // Same reasoning as Miner #1: exactly one proxy hop on Render, `1` not
  // `true` so a caller can't spoof X-Forwarded-For to collapse the rate
  // limiter into one shared bucket.
  app.set('trust proxy', 1);
  app.use(requestLogMiddleware);
  app.use(corsMiddleware);
  app.use(express.json());
  app.use(answerFieldMiddleware);
  app.use(misrouteWatchMiddleware);

  app.use('/health', healthRouter);
  app.use('/check-tx', checkTxRateLimit, misrouteHandoffMiddleware, checkTxRouter);
  app.use('/gas-price', checkGasPriceRateLimit, checkGasPriceRouter);
  app.use('/wallet-balance', checkWalletBalanceRateLimit, checkWalletBalanceRouter);
  app.use('/token-holders', checkTokenHoldersRateLimit, checkTokenHoldersRouter);
  app.use('/tvl', checkTvlRateLimit, checkTvlRouter);
  app.use('/crypto-price', checkCryptoPriceRateLimit, checkCryptoPriceRouter);
  app.use('/stock-price', checkStockPriceRateLimit, checkStockPriceRouter);
  app.use('/ssl-check', checkSslVerificationRateLimit, misrouteHandoffMiddleware, checkSslVerificationRouter);
  app.use('/weather-forecast', checkWeatherForecastRateLimit, checkWeatherForecastRouter);
  app.use('/storm-alert', checkStormAlertRateLimit, checkStormAlertRouter);
  app.use('/ip-geolocate', checkIpGeolocationRateLimit, checkIpGeolocationRouter);
  app.use('/academic-search', checkAcademicSearchRateLimit, checkAcademicSearchRouter);
  app.use('/web-search', checkWebSearchRateLimit, checkWebSearchRouter);
  app.use('/fraud-query', sentinelFraudRateLimit, misrouteHandoffMiddleware);
  app.use('/assess-wallet', sentinelFraudRateLimit, misrouteHandoffMiddleware);
  app.use('/', sentinelFraudRouter);

  return app;
}
