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
  getProtocolChainDetail,
  peekProtocolDetail,
  getDefiTotalTvl,
  getChainTvl,
  protocolDisplayName,
  ProtocolNotFoundError,
  ChainNotFoundError,
} from '../lib/defiLlamaApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { respondUnusableInput } from '../lib/unusableInput.js';
import { extractSubject, freeTextParam, looksLikeSentence, firstUsableValue } from '../lib/entityExtract.js';
import { resolveChainLoose } from '../lib/chains.js';
import { describeAddressMiss, ADDRESS_RE } from '../lib/addressContext.js';

const router = Router();

// A chain written as "the Polygon network" or "Ethereum mainnet" is the chain
// "Polygon" or "Ethereum"; a protocol written as "the Aave protocol" is "Aave".
// Found live 2026-11-12: a scored question read "for the Aave protocol on the
// Polygon network" and was looked up as the chain "the Polygon network", so it
// answered not_found.
export function cleanChainName(value) {
  if (typeof value !== 'string') return value;
  const cleaned = value.trim().replace(/[?.!]+$/, '').replace(/^(?:the|on|in)\s+/i, '')
    .replace(/\s+(?:network|chain|blockchain|mainnet|ecosystem|layer[\s-]?[12]|l[12])$/i, '').trim();
  return cleaned || value;
}

export function cleanProtocolName(value) {
  if (typeof value !== 'string') return value;
  const cleaned = value.trim().replace(/[?.!]+$/, '').replace(/^(?:(?:the|current|total|live|latest|present)\s+)+(?:of\s+)?(?:the\s+)?/i, '').replace(/^of\s+(?:the\s+)?/i, '')
    .replace(/\s+(?:protocol|dex|platform|dapp|finance protocol)$/i, '').trim();
  return cleaned || value;
}

export function extractTvlProtocol(question) {
  if (typeof question !== 'string') return null;
  // A one-protocol endpoint must not silently turn comparisons or joined
  // protocol lists into a lookup for whichever name happens to come first.
  if (/\bcompare\b/i.test(question) && /\b(?:TVL|value locked)\b/i.test(question)) return null;
  if (/\b(?:TVL\s+of|locked\s+in)\s+(?:the\s+)?[A-Z][\w-]*(?:\s+[A-Z][\w-]*)*\s+and\s+[A-Z][\w-]*\b/.test(question)) return null;
  const possessives = [...question.matchAll(/\b((?:[A-Z][\w-]*)(?:\s+[A-Z][\w-]*)*)[\u2019']s\b/g)]
    .map((match) => ({
      name: match[1].replace(/^(?:Report|Give|Show|Tell|Please)\s+/i, ''),
      end: match.index + match[0].length,
    }))
    .filter(({ name }) => !/^(?:What|Who|Where|When|Why|How|It)$/i.test(name));
  // More than one possessive name is an inherently comparative or nested
  // question. A single protocol TVL lookup cannot answer it honestly.
  if (possessives.length > 1) return null;
  if (possessives.length === 1) {
    const candidate = possessives[0];
    const governedText = question.slice(candidate.end);
    const directlyOwnsTvl = /^\s+(?:(?:current|present|live|aggregate|total)\s+)*(?:TVL|total value locked|value locked)\b/i.test(governedText);
    return directlyOwnsTvl ? candidate.name : null;
  }
  const lockedIn = question.match(/\blocked\s+in\s+(?:the\s+)?([A-Z][\w-]*(?:\s+(?!(?:DEX|protocol|across|over|on|for|with)\b)[A-Z][\w-]*)*)(?:\s+(?:DEX|protocol))?\b/);
  return lockedIn ? lockedIn[1] : extractSubject(question);
}

async function handleTvl(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  // Trimmed here, not just in the transport: an untrimmed value still
  // reached the answer text and the canonical string, so a caller sending
  // " Base " got the right number reported under a ragged name.
  const rawProtocol = typeof params?.protocol === 'string' ? params.protocol.trim() : params?.protocol;
  const suppliedChain = firstUsableValue(params?.tvl_chain, params?.chain);
  const rawTvlChain = typeof suppliedChain === 'string' ? cleanChainName(suppliedChain) : suppliedChain;
  // Free-text fallback. "How much TVL does Curve have on Ethereum?" arrives
  // as a question rather than protocol=curve&tvl_chain=Ethereum, and this
  // route used to answer invalid_input to all of it. The question reduces
  // to a subject, and a trailing "on <chain>" clause splits off as the
  // chain — both then go through the same alias resolution as an explicit
  // param, so a name DefiLlama has renamed still lands.
  // A whole question can arrive *as* the protocol parameter, not only
  // alongside it: the engine sends protocol="How much value is locked in
  // Uniswap?" verbatim. Reading that as a protocol name looked one up by
  // the entire sentence and always missed, so measured against the live
  // network on 2026-09-02 this endpoint failed every natural-language TVL
  // question put to it. Prose in the parameter is now treated as the
  // question it is.
  let chainFromProtocol;
  const protocolIsProse = looksLikeSentence(rawProtocol);
  const usableProtocol = protocolIsProse ? null : rawProtocol;
  const question = !usableProtocol && !rawTvlChain
    ? (protocolIsProse ? rawProtocol : freeTextParam(params))
    : null;
  const subject = question ? extractTvlProtocol(question) : null;
  const split = subject ? subject.match(/^(.*?)\s+\bon\s+(.+)$/i) : null;
  // firstUsableValue rather than `??`: when the engine sends protocol as an
  // empty string, `rawProtocol` trims to "" and `??` keeps it, because an
  // empty string is neither null nor undefined. The free-text subject read
  // out of the question below was then thrown away and the route answered
  // invalid_input to a question that names its protocol plainly. Caught
  // 2026-09-14 verifying the empty-parameter fix: protocol= with
  // query="What is the TVL of Uniswap?" refused, while omitting protocol
  // entirely answered correctly.
  let protocol = cleanProtocolName(firstUsableValue(usableProtocol, split ? split[1].trim() : subject));
  let wholeDefi = false;
  // "the TVL of the Solana blockchain" names a chain, and "all of DeFi" names
  // the whole market; neither is a protocol.
  if (typeof protocol === 'string' && !rawTvlChain) {
    if (/^(?:all(?:\s+of)?\s+)?(?:de-?fi|decentralized finance)(?:\s+(?:combined|overall|total|as a whole|protocols))?$/i.test(protocol)) {
      wholeDefi = true;
      protocol = undefined;
    } else if (/\s+(?:blockchain|network|chain|mainnet)$/i.test(protocol)) {
      chainFromProtocol = cleanChainName(protocol);
      protocol = undefined;
    }
  }
  const tvlChain = rawTvlChain ?? chainFromProtocol ?? (split ? cleanChainName(split[2]) : undefined);

  if (wholeDefi && !tvlChain) {
    try {
      const total = await getDefiTotalTvl();
      const signedPct = (n) => `${n >= 0 ? 'up' : 'down'} ${Math.abs(n).toFixed(2)}%`;
      const parts = [`DeFi has $${total.value.toFixed(2)} total value locked across all chains according to DefiLlama.`];
      if (total.change1dPct !== null && total.change7dPct !== null) parts.push(`That is ${signedPct(total.change1dPct)} over the last day and ${signedPct(total.change7dPct)} over the last 7 days.`);
      parts.push('Source: DefiLlama (api.llama.fi), read at request time.');
      return res.json({
        query_type: 'defi_total',
        query: 'DeFi',
        status: 'ok',
        summary: parts.join(' '),
        confidence: 1.0,
        canonical: ['defi_total', Math.round(total.value)].join(':'),
        tvl_usd: total.value,
        change_1d_pct: total.change1dPct,
        change_7d_pct: total.change7dPct,
        source: 'DefiLlama',
        as_of: new Date().toISOString(),
      });
    } catch (err) {
      return res.json({
        query_type: 'defi_total',
        query: 'DeFi',
        status: 'unavailable',
        verdict: 'unavailable',
        summary: 'DefiLlama did not answer in time for the DeFi total, so no total value locked is stated rather than an old figure guessed.',
        confidence: 0.3,
        tvl_usd: null,
        error: err.message,
        as_of: new Date().toISOString(),
      });
    }
  }

  if (!protocol && !tvlChain) {
    return respondUnusableInput(
      res,
      'I cannot report total value locked because neither a protocol nor a chain was named. Pass a protocol such as "aave" or "uniswap" as the protocol parameter, or a chain such as "Ethereum" or "Base" as the tvl_chain parameter, or send both together to get one protocol value locked on one chain.',
    );
  }

  const queryType = protocol && tvlChain ? 'protocol_chain' : protocol ? 'protocol' : 'chain';
  const query = protocol && tvlChain ? `${protocol}:${tvlChain}` : protocol ?? tvlChain;

  let tvlUsd;
  let detail = null;
  let protocolTotalTvlUsd = null;
  try {
    if (protocol && tvlChain) {
      [detail, protocolTotalTvlUsd] = await Promise.all([
        getProtocolChainDetail(protocol, tvlChain),
        getProtocolTvl(protocol).catch(() => null),
      ]);
      tvlUsd = detail.value;
    } else {
      tvlUsd = protocol ? await getProtocolTvl(protocol) : await getChainTvl(tvlChain);
      if (protocol) detail = peekProtocolDetail(protocol);
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
    // A 200 with the fields named, never a 5xx: a 5xx is booked as no answer.
    return res.json({
      query_type: queryType,
      query,
      status: 'unavailable',
      verdict: 'unavailable',
      summary: `DefiLlama did not answer in time for ${query}, so no total value locked is stated rather than an old figure guessed.`,
      confidence: 0.3,
      tvl_usd: null,
      protocol: protocol ?? null,
      tvl_chain: tvlChain ?? null,
      source: 'DefiLlama',
      error: err.message,
      as_of: new Date().toISOString(),
    });
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
  // One figure per sentence, and it is the figure that was asked for: with a
  // chain named, that is the protocol's value locked on that chain. The
  // all-chain total stays in protocol_total_tvl_usd and is never put in its
  // place (answering "Aave on Polygon" with Aave's total across every chain
  // states a number about a different question).
  // The sentences after the figure add context in percentages and counts, never
  // a second dollar amount, so the one dollar figure in the answer is the one
  // that was asked for.
  const headline = protocol && tvlChain
    ? `${protocolName} on ${tvlChain} has $${tvlUsd.toFixed(2)} TVL according to DefiLlama.`
    : `${protocolName ?? query} has $${tvlUsd.toFixed(2)} TVL according to DefiLlama.`;
  const extra = [];
  const signed = (n) => `${n >= 0 ? 'up' : 'down'} ${Math.abs(n).toFixed(2)}%`;
  if (detail) {
    const scope = tvlChain ? `On ${tvlChain} it` : 'It';
    if (detail.change1dPct !== null && detail.change7dPct !== null) {
      extra.push(`${scope} is ${signed(detail.change1dPct)} over the last day and ${signed(detail.change7dPct)} over the last 7 days.`);
    } else if (detail.change1dPct !== null) {
      extra.push(`${scope} is ${signed(detail.change1dPct)} over the last day.`);
    }
    if (detail.chainsCount && !tvlChain) extra.push(`${protocolName} runs on ${detail.chainsCount} chains.`);
    if (tvlChain && protocolTotalTvlUsd > 0 && tvlUsd >= 0) {
      const share = (tvlUsd / protocolTotalTvlUsd) * 100;
      extra.push(`That is ${share < 0.01 ? 'under 0.01' : share.toFixed(2)}% of ${protocolName}'s total value locked across all chains.`);
    }
    if (detail.category) extra.push(`Its DefiLlama category is ${detail.category}.`);
  }
  extra.push('Source: DefiLlama (api.llama.fi), read at request time.');
  const summary = [headline, ...extra].join(' ');
  res.json({
    query_type: queryType,
    query,
    status: 'ok',
    summary,
    confidence: 1.0,
    canonical: [queryType, query, Math.round(tvlUsd)].join(':'),
    tvl_usd: tvlUsd,
    chain_tvl_usd: protocol && tvlChain ? tvlUsd : null,
    change_1d_pct: detail?.change1dPct ?? null,
    change_7d_pct: detail?.change7dPct ?? null,
    category: detail?.category ?? null,
    source: 'DefiLlama',
    protocol_total_tvl_usd: protocolTotalTvlUsd,
    protocol: protocol ?? null,
    tvl_chain: tvlChain ?? null,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleTvl(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleTvl(req, res)));

export default router;
