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

// Same limit/window on all six signal routes — each spends its own
// upstream quota (Ankr, Blockscout, or DefiLlama), no reason to size them
// differently.
function signalRateLimit() {
  return rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many requests — slow down and try again shortly' },
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

export function buildApp() {
  const app = express();
  // Same reasoning as Miner #1: exactly one proxy hop on Render, `1` not
  // `true` so a caller can't spoof X-Forwarded-For to collapse the rate
  // limiter into one shared bucket.
  app.set('trust proxy', 1);
  app.use(requestLogMiddleware);
  app.use(corsMiddleware);
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/check-tx', checkTxRateLimit, checkTxRouter);
  app.use('/gas-price', checkGasPriceRateLimit, checkGasPriceRouter);
  app.use('/wallet-balance', checkWalletBalanceRateLimit, checkWalletBalanceRouter);
  app.use('/token-holders', checkTokenHoldersRateLimit, checkTokenHoldersRouter);
  app.use('/tvl', checkTvlRateLimit, checkTvlRouter);
  app.use('/crypto-price', checkCryptoPriceRateLimit, checkCryptoPriceRouter);
  app.use('/stock-price', checkStockPriceRateLimit, checkStockPriceRouter);
  app.use('/ssl-check', checkSslVerificationRateLimit, checkSslVerificationRouter);

  return app;
}
