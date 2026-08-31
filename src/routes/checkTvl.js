// TVL_LOOKUP signal endpoint. Uses DefiLlama's public API, not
// Ankr/Blockscout — TVL is an aggregated/indexed figure no chain RPC
// exposes directly. Accepts `protocol` (a DefiLlama protocol slug, e.g.
// "uniswap") and/or `tvl_chain` or `chain` (a free-text DefiLlama chain name, e.g.
// "Ethereum"). `tvl_chain` remains the preferred broad DefiLlama field,
// while `chain` is accepted because dispatchers also use that ordinary
// field for explicit protocol-on-chain requests.
//
// Used to reject the request outright when both were supplied. Confirmed
// live 2026-08-25 via Render request logs that Telegraph's dispatcher
// regularly sends both together for a question like "Aave V3 protocol on
// the Ethereum chain" — both facts are true, so it reasonably passes both.
// That meant every graded TVL question on a named protocol was 400ing and
// scoring as a blank answer, a bug in our own validation, not a grading or
// uptime problem. Now `protocol` wins when both are present (it's the more
// specific identifier) and `tvl_chain` is only used alone.

import { Router } from 'express';
import {
  getProtocolTvl,
  getProtocolChainTvl,
  getChainTvl,
  protocolDisplayName,
  ProtocolNotFoundError,
  ChainNotFoundError,
} from '../lib/defiLlamaApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { extractSubject, freeTextParam } from '../lib/entityExtract.js';
import { resolveChainLoose } from '../lib/chains.js';
import { describeAddressMiss, ADDRESS_RE } from '../lib/addressContext.js';

const router = Router();

async function handleTvl(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  // Trimmed here, not just in the transport: an untrimmed value still
  // reached the answer text and the canonical string, so a caller sending
  // " Base " got the right number reported under a ragged name.
  const rawProtocol = typeof params?.protocol === 'string' ? params.protocol.trim() : params?.protocol;
  const suppliedChain = params?.tvl_chain ?? params?.chain;
  const rawTvlChain = typeof suppliedChain === 'string' ? suppliedChain.trim() : suppliedChain;
  // Free-text fallback. "How much TVL does Curve have on Ethereum?" arrives
  // as a question rather than protocol=curve&tvl_chain=Ethereum, and this
  // route used to answer invalid_input to all of it. The question reduces
  // to a subject, and a trailing "on <chain>" clause splits off as the
  // chain — both then go through the same alias resolution as an explicit
  // param, so a name DefiLlama has renamed still lands.
  const question = !rawProtocol && !rawTvlChain ? freeTextParam(params) : null;
  const subject = question ? extractSubject(question) : null;
  const split = subject ? subject.match(/^(.*?)\s+\bon\s+(.+)$/i) : null;
  const protocol = rawProtocol ?? (split ? split[1].trim() : subject ?? undefined);
  const tvlChain = rawTvlChain ?? (split ? split[2].trim() : undefined);

  if (!protocol && !tvlChain) {
    return respondUnusableInput(
      res,
      'I cannot report total value locked because neither a protocol nor a chain was named. Pass a protocol such as "aave" or "uniswap" as the protocol parameter, or a chain such as "Ethereum" or "Base" as the tvl_chain parameter, or send both together to get one protocol value locked on one chain.',
    );
  }

  const queryType = protocol && tvlChain ? 'protocol_chain' : protocol ? 'protocol' : 'chain';
  const query = protocol && tvlChain ? `${protocol}:${tvlChain}` : protocol ?? tvlChain;

  let tvlUsd;
  let protocolTotalTvlUsd = null;
  try {
    if (protocol && tvlChain) {
      [tvlUsd, protocolTotalTvlUsd] = await Promise.all([
        getProtocolChainTvl(protocol, tvlChain),
        getProtocolTvl(protocol),
      ]);
    } else {
      tvlUsd = protocol ? await getProtocolTvl(protocol) : await getChainTvl(tvlChain);
    }
  } catch (err) {
    if (err instanceof ProtocolNotFoundError || err instanceof ChainNotFoundError) {
      // DefiLlama is keyed on protocol names, so a contract or wallet
      // address never matches and the caller gets told nothing they did not
      // already know. When an address was passed, say what it actually is.
      // The chain is only consulted when the caller named one that resolves;
      // guessing which chain an address lives on would be a coin flip, so
      // without one the answer stays at the level that is certainly true.
      let summary = `no DefiLlama ${queryType} found for '${query}'`;
      if (protocol && ADDRESS_RE.test(protocol)) {
        const chain = tvlChain ? resolveChainLoose(String(tvlChain)) : null;
        const described = chain
          ? await describeAddressMiss(chain.segment, protocol, chain.label, 'total value locked')
          : null;
        summary = described
          ?? `${protocol} is a contract or wallet address, not a DeFi protocol name, so it has no total value locked. DefiLlama reports total value locked by protocol, such as "aave" or "uniswap".`;
      }
      return res.json({
        query_type: queryType,
        query,
        status: 'not_found',
        summary,
        confidence: 1.0,
        canonical: [queryType, query, 'not_found'].join(':'),
        tvl_usd: null,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'TVL lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream TVL data call failed', confidence: 1.0, error: err.message });
  }

  const as_of = new Date().toISOString();
  // Plain decimal, no thousands separators: verified against the live
  // champion TVL_LOOKUP scorer (registration #49) that comma-grouped,
  // whole-dollar-rounded figures ("$18,032,399,744") score 0.0201 — barely
  // above an answer wrong by four orders of magnitude (0.0196) — while the
  // same value written as a plain decimal ("$18032065663.82") scores 0.9711.
  // Same root cause as the ONCHAIN_TX_LOOKUP fix: the scorer can't parse a
  // comma-grouped number as a single value.
  // Name the protocol DefiLlama actually measured when the caller used a
  // retired name: asking for "maker" reports Sky Lending's TVL, and stating
  // that number under the retired name is misleading on its own terms and
  // unlikely to match a ground truth using the current name. Only rebrands
  // are rewritten (a lookup in a static table, no extra network call) —
  // a name that resolves normally is echoed back as the caller wrote it.
  const protocolName = protocol ? protocolDisplayName(protocol) : null;
  const summary = protocol && tvlChain
    ? `${protocolName} on ${tvlChain} has $${tvlUsd.toFixed(2)} TVL; the protocol has $${protocolTotalTvlUsd.toFixed(2)} total TVL across all chains, according to DefiLlama.`
    : `${protocolName ?? query} has $${tvlUsd.toFixed(2)} TVL according to DefiLlama.`;
  res.json({
    query_type: queryType,
    query,
    status: 'ok',
    summary,
    confidence: 1.0,
    canonical: [queryType, query, Math.round(tvlUsd)].join(':'),
    tvl_usd: tvlUsd,
    chain_tvl_usd: protocol && tvlChain ? tvlUsd : null,
    protocol_total_tvl_usd: protocolTotalTvlUsd,
    protocol: protocol ?? null,
    tvl_chain: tvlChain ?? null,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleTvl(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleTvl(req, res)));

export default router;
