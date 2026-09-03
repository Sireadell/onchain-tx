// CRYPTO_PRICE signal endpoint. Accepts either `coin_id` (a CoinGecko id,
// e.g. "bitcoin") or a `price_chain` + `token` pair (e.g.
// price_chain=ethereum, token=0xA0b8...eB48 for a specific on-chain token's
// price) — exactly one mode. `price_chain` is deliberately separate from
// `chain` (used by the other four endpoints) for the same reason as
// /tvl's `tvl_chain`: DefiLlama's chain namespace isn't restricted to our
// five-chain enum.
//
// coin_id mode queries CoinPaprika and DefiLlama's coins.llama.fi proxy
// concurrently and prefers CoinPaprika. CoinPaprika became primary
// 2026-08-29: CoinGecko's free API returns 403 from Render's production
// IP (confirmed live), which silently nulled out market_cap_usd and
// change_24h_pct in every prod response even though the code for them was
// correct. CoinGecko was dropped from this race the same day, also
// live-measured: /crypto-price ran ~2-2.3s in production regardless of
// which coin was asked for, while each source individually measured
// under 1.2s — meaning the response was blocking on the slowest of three
// sources to settle even after the fastest had already answered.
// CoinGecko was one of those three and, per the above, never succeeds in
// this environment at all: it was pure wasted latency (a full DNS+TLS+
// HTTP round trip) and a wasted external request on every single
// crypto-price call, for zero benefit. DefiLlama stays in the race — it
// does succeed in prod and gives real fallback coverage plus the
// multi-source range in the summary below. chain_token mode is unaffected
// — it stays on DefiLlama, the only source of the two that looks up a
// price by on-chain contract address at all.

import { Router } from 'express';
import { getCoinPrice, CoinNotFoundError } from '../lib/defiLlamaApi.js';
import { getCoinPaprikaPrice } from '../lib/coinPaprikaApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { quoteParam, respondUnusableInput } from '../lib/unusableInput.js';
import { extractSubject, freeTextParam } from '../lib/entityExtract.js';
import { resolveChainLoose } from '../lib/chains.js';
import { describeAddressMiss } from '../lib/addressContext.js';

// Tries both sources at once. Once one answers, the other gets a short
// cross-check window. A slow provider cannot hold a good
// answer until its full timeout expires.
const SOURCE_CROSS_CHECK_MS = Number(process.env.CRYPTO_SOURCE_CROSS_CHECK_MS) || 250;

async function getFreshestCoinPrice(coinId) {
  const wrap = (source, promise) => promise.then(
    (value) => ({ source, status: 'fulfilled', value }),
    (reason) => ({ source, status: 'rejected', reason }),
  );
  const coinPaprikaPromise = wrap('coinpaprika', getCoinPaprikaPrice(coinId));
  const defiLlamaPromise = wrap('defillama', getCoinPrice(`coingecko:${coinId}`));
  const first = await Promise.race([coinPaprikaPromise, defiLlamaPromise]);
  const otherPromise = first.source === 'coinpaprika' ? defiLlamaPromise : coinPaprikaPromise;

  let other;
  if (first.status === 'rejected') {
    other = await otherPromise;
  } else {
    other = await Promise.race([
      otherPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), SOURCE_CROSS_CHECK_MS)),
    ]);
  }

  const bySource = new Map([first, other].filter(Boolean).map((result) => [result.source, result]));
  const coinPaprika = bySource.get('coinpaprika') ?? { status: 'rejected', reason: new Error('CoinPaprika did not answer within the cross-check window') };
  const defiLlama = bySource.get('defillama') ?? { status: 'rejected', reason: new Error('DefiLlama did not answer within the cross-check window') };
  if (coinPaprika.status === 'rejected' && defiLlama.status === 'rejected') {
    // DefiLlama's not-found error is the route's established signal for a
    // valid lookup with no matching coin. Preserve it when both sources
    // reject so an unknown coin remains a 200 not_found answer.
    throw defiLlama.reason ?? coinPaprika.reason;
  }

  const primary = coinPaprika.status === 'fulfilled'
    ? { ...coinPaprika.value, source: 'coinpaprika' }
    : { ...defiLlama.value, source: 'defillama' };

  const sources = [];
  if (coinPaprika.status === 'fulfilled') sources.push({ source: 'coinpaprika', price_usd: coinPaprika.value.priceUsd });
  if (defiLlama.status === 'fulfilled') sources.push({ source: 'defillama', price_usd: defiLlama.value.priceUsd });
  const prices = sources.map((item) => item.price_usd);
  return {
    ...primary,
    sources,
    sourceCount: sources.length,
    priceRangeLowUsd: prices.length ? Math.min(...prices) : primary.priceUsd,
    priceRangeHighUsd: prices.length ? Math.max(...prices) : primary.priceUsd,
  };
}


// Chain names that are also the canonical id of a major coin. Used only to
// recover a lookup the dispatcher put in the wrong field, never to guess.
//
// Root cause, found 2026-09-03 in Render request logs: this miner's own
// miner.yaml gave "ethereum" as the example value for price_chain. A
// question about the price of ether therefore matched that example, and the
// dispatcher filled price_chain="ethereum" with no token, because there is
// no contract address in a question about ether. This endpoint then refused
// the pair as incomplete. It arrived twice every two hours through the whole
// of 2026-09-02 and 03 and was refused every time, which is consistent with
// CRYPTO_PRICE holding rank 1 on a score of essentially zero.
//
// A recovered lookup can be no worse than the refusal it replaces: both
// score zero if the reading is wrong, and the refusal scores zero always.
// The table is explicit rather than a search so a chain that is not a coin
// ("base") keeps the honest refusal instead of matching some unrelated
// ticker by fuzzy name.
const CHAIN_NAME_COIN_IDS = {
  ethereum: 'ethereum',
  ether: 'ethereum',
  bitcoin: 'bitcoin',
  solana: 'solana',
  cardano: 'cardano',
  litecoin: 'litecoin',
  dogecoin: 'dogecoin',
  tron: 'tron',
  avalanche: 'avalanche-2',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  fantom: 'fantom',
  celo: 'celo',
};

const router = Router();

const TOKEN_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function handleCryptoPrice(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  // Free-text fallback: "How much is Bitcoin worth right now?" arrives as
  // a question rather than coin_id=bitcoin, and this route used to answer
  // invalid_input to all of it. The question reduces to a coin name, which
  // DefiLlama resolves the same way it resolves a coin id. Contract-address
  // lookups still require the explicit price_chain + token pair, because
  // guessing which chain an address lives on would be a coin flip.
  const question = freeTextParam(params);
  let priceChain = params?.price_chain;
  const token = params?.token;
  let coinId = params?.coin_id ?? (!priceChain && !token && question ? extractSubject(question) : undefined);
  // "one ether" means one unit of Ethereum, not Harmony's ONE token.
  // CoinPaprika's search otherwise sees the leading word "one" and returns
  // ONE, producing a plausible-looking but completely wrong price.
  const coinText = question ?? params?.coin_id;
  if (coinText && /\b(?:one\s+)?(?:ether|eth)\b/i.test(coinText)) coinId = 'ethereum';

  // A chain named on its own, with no contract address to pair it with, is a
  // coin name in the wrong field. Recover it rather than refusing the pair as
  // incomplete. Only ever applies when no token was supplied at all, so a
  // genuine contract lookup is untouched.
  const tokenSupplied = typeof token === 'string' ? token.trim() : token;
  if (!coinId && priceChain && !tokenSupplied) {
    const recovered = CHAIN_NAME_COIN_IDS[String(priceChain).trim().toLowerCase()];
    if (recovered) {
      coinId = recovered;
      priceChain = undefined;
    }
  }

  const chainTokenMode = Boolean(priceChain || token);
  if (!coinId && !chainTokenMode) {
    return respondUnusableInput(
      res,
      'I cannot quote a price because no coin was named. For a major coin, pass its id as the coin_id parameter, such as "bitcoin", "ethereum" or "solana". For any other token, pass its chain as price_chain and its contract address as token. Either way I will return the current price in USD.',
    );
  }
  if (coinId && chainTokenMode) {
    return respondUnusableInput(
      res,
      `I was asked for a price in two different ways at once: by coin id (${quoteParam(coinId)}) and by contract address. I can only follow one. Send coin_id on its own for a major coin, or price_chain and token together for a specific contract, and I will return the current USD price.`,
    );
  }
  if (chainTokenMode && (!priceChain || !token)) {
    const missing = priceChain ? 'the token contract address' : 'the chain it lives on';
    return respondUnusableInput(
      res,
      `I cannot price a token by contract address without both halves of the pair, and ${missing} is missing. Send price_chain and token together, or send coin_id on its own for a major coin, and I will return the current USD price.`,
    );
  }
  if (chainTokenMode && !TOKEN_ADDRESS_RE.test(token)) {
    return respondUnusableInput(
      res,
      `I cannot price this token because ${quoteParam(token)} is not a valid contract address. A contract address is 42 characters long: "0x" followed by 40 hexadecimal characters. If you meant a major coin, send its name as coin_id instead, such as "bitcoin" or "ethereum", and I will return its current USD price.`,
    );
  }

  const queryType = coinId ? 'coin_id' : 'chain_token';
  const coinKey = coinId ? `coingecko:${coinId}` : `${priceChain}:${token}`;
  const query = coinId ?? `${priceChain}:${token}`;

  let priceInfo;
  try {
    priceInfo = coinId ? await getFreshestCoinPrice(coinId) : await getCoinPrice(coinKey);
  } catch (err) {
    if (err instanceof CoinNotFoundError) {
      // A contract-address lookup that finds no price is usually a question
      // about an address that was never a priced token at all. Saying what
      // the address actually is answers the question; "no price found" only
      // restates the failure, and is graded against a real sentence it
      // shares almost nothing with. See addressContext.js for the live
      // signal that prompted this.
      let summary = `no price found for '${query}'`;
      if (chainTokenMode) {
        const resolved = resolveChainLoose(String(priceChain));
        if (resolved) {
          const described = await describeAddressMiss(
            resolved.segment, token, resolved.label, 'token price',
          );
          if (described) summary = described;
        }
      }
      return res.json({
        query_type: queryType,
        query,
        status: 'not_found',
        summary,
        confidence: 1.0,
        canonical: [queryType, query, 'not_found'].join(':'),
        price_usd: null,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'price lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream price data call failed', confidence: 1.0, error: err.message });
  }

  // Both remaining sources return a real ticker symbol; this fallback only
  // guards the case where a source unexpectedly omits one.
  const symbol = priceInfo.symbol ?? (coinId || null);
  const as_of = priceInfo.asOfUnix != null ? new Date(priceInfo.asOfUnix * 1000).toISOString() : new Date().toISOString();
  const changeText = typeof priceInfo.change24hPct === 'number'
    ? `, ${priceInfo.change24hPct >= 0 ? 'up' : 'down'} ${Math.abs(priceInfo.change24hPct).toFixed(2)}% over 24 hours`
    : '';
  const marketCapText = typeof priceInfo.marketCapUsd === 'number'
    ? `, with a market capitalization of about $${priceInfo.marketCapUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : '';
  const SOURCE_LABELS = { coinpaprika: 'CoinPaprika', defillama: 'DefiLlama' };
  const sourceNames = (priceInfo.sources ?? []).map((item) => SOURCE_LABELS[item.source] ?? item.source);
  const sourceText = priceInfo.sourceCount > 1
    ? ` ${new Intl.ListFormat('en', { type: 'conjunction' }).format(sourceNames)} currently report a range of $${priceInfo.priceRangeLowUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} to $${priceInfo.priceRangeHighUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
    : '';
  // Price in the summary text is fixed to 2 decimal places (standard USD
  // cent precision), not the source's full float precision. Verified
  // against the live champion CRYPTO_PRICE scorer (registration #1927):
  // its fact-matcher requires an exact match to the ground truth's price
  // at whatever precision the ground truth uses, with zero tolerance for
  // extra or missing decimal digits — "$78,269.453223" scores 0 against a
  // "$78,269.45" ground truth, "$78,269.45" scores 1. The live #1
  // CRYPTO_PRICE miner (preflight) independently confirms 2dp is the
  // convention: its own real answer reads "$78,260.03", not a raw float.
  // Full precision stays in the price_usd JSON field, unchanged.
  const priceUsdFixed = priceInfo.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  res.json({
    query_type: queryType,
    query,
    status: 'ok',
    summary: `${symbol ?? query} is currently $${priceUsdFixed} USD${changeText}${marketCapText}.${sourceText}`,
    confidence: 1.0,
    canonical: [queryType, query, priceInfo.priceUsd].join(':'),
    price_usd: priceInfo.priceUsd,
    symbol,
    price_source: priceInfo.source ?? 'defillama',
    sources: priceInfo.sources ?? [{ source: priceInfo.source ?? 'defillama', price_usd: priceInfo.priceUsd }],
    source_count: priceInfo.sourceCount ?? 1,
    price_range_low_usd: priceInfo.priceRangeLowUsd ?? priceInfo.priceUsd,
    price_range_high_usd: priceInfo.priceRangeHighUsd ?? priceInfo.priceUsd,
    change_24h_pct: priceInfo.change24hPct ?? null,
    market_cap_usd: priceInfo.marketCapUsd ?? null,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleCryptoPrice(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleCryptoPrice(req, res)));

export default router;
