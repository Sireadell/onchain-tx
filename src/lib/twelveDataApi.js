// Official Twelve Data stock quote API. This is the primary STOCK_PRICE
// source when TWELVE_DATA_API_KEY is configured.

import { checkBudget } from './ankrRpc.js';

const CALL_TIMEOUT_MS = Number(process.env.TWELVE_DATA_CALL_TIMEOUT_MS) || 5_000;

export class TwelveDataTickerNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TwelveDataTickerNotFoundError';
  }
}

export async function getTwelveDataStockQuote(ticker) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY is not configured');

  checkBudget();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  let res;
  try {
    const url = new URL('https://api.twelvedata.com/quote');
    url.searchParams.set('symbol', ticker);
    url.searchParams.set('apikey', apiKey);
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Twelve Data request timed out after ${CALL_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status === 'error') {
    const message = body?.message ?? `${res.status} ${res.statusText}`;
    if (/not found|invalid symbol|symbol.*exist/i.test(message)) {
      throw new TwelveDataTickerNotFoundError(`no Twelve Data quote found for '${ticker}'`);
    }
    throw new Error(`Twelve Data request failed: ${message}`);
  }

  const price = Number(body?.close);
  if (!Number.isFinite(price) || price <= 0) {
    throw new TwelveDataTickerNotFoundError(`no Twelve Data quote found for '${ticker}'`);
  }

  return {
    priceUsd: price,
    currency: body.currency ?? 'USD',
    exchangeName: body.exchange ?? null,
    asOfUnix: Number.isFinite(Number(body.timestamp)) ? Number(body.timestamp) : null,
    source: 'twelve_data',
  };
}
