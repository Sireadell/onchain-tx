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
