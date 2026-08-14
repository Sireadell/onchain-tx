// ADAPTED from telegraph-forensics-miner/src/app.js (Miner #1) — same
// reasoning applies here: no payment gate of our own (Telegraph's dispatcher
// handles that upstream), rate limiting still matters because this endpoint
// spends our own Ankr quota on every call and the HTTP endpoint itself is a
// plain public URL underneath the dispatcher.

import express from 'express';
import rateLimit from 'express-rate-limit';
import healthRouter from './routes/health.js';
import checkTxRouter from './routes/checkTx.js';

const checkTxRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests — slow down and try again shortly' },
});

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
  app.use(corsMiddleware);
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/check-tx', checkTxRateLimit, checkTxRouter);

  return app;
}
