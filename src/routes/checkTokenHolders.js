// TOKEN_HOLDER_COUNT signal endpoint. No ground truth exists for this
// intent yet (checked live against /groundtruths/TOKEN_HOLDER_COUNT,
// 2026-08-18) — same speculative-on-grading caveat as the other two new
// endpoints. Uses Blockscout's REST API, not Ankr's JSON-RPC (Ankr has no
// direct holder-count method) — see blockscoutApi.js.

import { Router } from 'express';
import { wantsSolana } from '../lib/solanaRpc.js';
import { answerSolanaHolders } from '../lib/solanaAnswers.js';
import { getTokenInfo, searchTokenByName, TokenNotFoundError } from '../lib/blockscoutApi.js';
import { tokenFromText } from './checkTokenTotalSupply.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { CHAINS, DEFAULT_CHAIN, resolveChainLoose } from '../lib/chains.js';
import { quoteParam, respondUnusableInput } from '../lib/unusableInput.js';
import { extractAddress, freeTextParam, firstUsableValue } from '../lib/entityExtract.js';
import { resolveTokenByName } from '../lib/supplyAsk.js';
import { describeAddressMiss } from '../lib/addressContext.js';

const router = Router();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// The token a question names when it gives no address: "how many holders
// does Chainlink have on Ethereum" -> "Chainlink". Chain words and filler
// ("token", "coin", "the") are dropped. Null when no name can be read.
export function tokenNameFromQuestion(text) {
  const t = String(text ?? '').replace(/[?!.]+\s*$/, '').trim();
  const patterns = [
    /holders?\s+(?:count\s+)?(?:does|do|of|for|in)\s+(.+?)(?:\s+(?:have|has|got)\b|$)/i,
    /(?:how many|number of)\s+(?:people|wallets|addresses|accounts)\s+(?:hold|own)\s+(.+)$/i,
    /^(?:how many\s+)?(.+?)\s+(?:token\s+)?holders?\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const name = m[1]
      .replace(/\s+(?:on|in)\s+(?:the\s+)?[a-z ]+?(?:\s+(?:chain|network|mainnet))?$/i, '')
      .replace(/^(?:the|a)\s+/i, '')
      .replace(/\s+(?:token|tokens|coin|coins|stablecoin)$/i, '')
      .trim();
    if (name && name.length <= 40 && !/^(?:how many|the|it|this)$/i.test(name)) return name;
  }
  return null;
}

export async function handleTokenHolders(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  // Same free-text fallback as the other on-chain routes: the engine
  // sends "how many holders does 0xabc... have on Base" as a question, not
  // as a bare token param.
  const question = freeTextParam(params);
  const rawToken = firstUsableValue(params?.token, question);
  if (wantsSolana(params?.chain, params?.token, question)) return answerSolanaHolders(params, res);
  // Exact match first; if that fails, pull a contract address out of
  // whatever was sent instead of rejecting outright. See entityExtract.js.
  let token = rawToken && ADDRESS_RE.test(rawToken) ? rawToken : extractAddress(rawToken);
  const chainParam = firstUsableValue(params?.chain, resolveChainLoose(question ?? '')?.key, DEFAULT_CHAIN);

  // No address: resolve a named token, the well-known table first and then
  // Blockscout's search on the asked chain.
  if (!token && rawToken) {
    const named = resolveChainLoose(chainParam);
    const known = named ? tokenFromText(rawToken, named.key) : null;
    if (known?.address) token = known.address;
    else if (named) {
      const name = tokenNameFromQuestion(rawToken) ?? (rawToken.trim().split(/\s+/).length <= 3 ? rawToken.trim() : null);
      const found = name ? await searchTokenByName(named.blockscoutHost, name) : null;
      if (found) token = found.address;
      else {
        // The wider reader: tokens named inside a longer question, on every supported chain.
        const wide = await Promise.race([resolveTokenByName(rawToken, named).catch(() => null), new Promise((r) => setTimeout(() => r(null), 10_000))]);
        if (wide) token = wide.address;
      }
    }
  }

  if (!token) {
    const problem = rawToken
      ? `${quoteParam(rawToken)} does not contain a valid token contract address`
      : 'no token contract address was supplied';
    return respondUnusableInput(
      res,
      `I cannot count holders because ${problem}. I need the token's contract address, which is 42 characters long: "0x" followed by 40 hexadecimal characters. Name a widely traded token (for example USDC or Chainlink) or pass the contract address as the token parameter and I will return its holder count.`,
    );
  }

  const chain = resolveChainLoose(chainParam);
  if (!chain) {
    return respondUnusableInput(
      res,
      `I cannot count holders on ${quoteParam(chainParam)} because it is not a chain I index. I can count token holders on ${Object.keys(CHAINS).join(', ')}. Ask again naming one of those and I will return the holder count for that token.`,
    );
  }

  let info;
  let correction = null;
  try {
    try {
      info = await getTokenInfo(chain.blockscoutHost, token, chain.segment);
    } catch (first) {
      // The address in the question is not a token. If the question also names
      // the token in words, count that token's holders and say what was swapped.
      if (first instanceof RpcBudgetExceededError || !rawToken) throw first;
      const alt = await Promise.race([resolveTokenByName(rawToken, chain).catch(() => null), new Promise((r) => setTimeout(() => r(null), 10_000))]);
      if (!alt || alt.address.toLowerCase() === token.toLowerCase()) throw first;
      correction = `The address ${token} in the question is not a token contract on ${chain.label}; the token named in the question is ${alt.symbol ?? 'the token'} at ${alt.address}, so that contract is counted instead.`;
      token = alt.address;
      info = await getTokenInfo(chain.blockscoutHost, token, chain.segment);
    }
  } catch (err) {
    if (err instanceof TokenNotFoundError) {
      // "No token found here" is true but says nothing about what is
      // actually at the address. One eth_getCode call separates a wallet
      // from a contract that simply is not an ERC-20, and either is a real
      // answer to the question. See addressContext.js.
      const described = await describeAddressMiss(chain.segment, token, chain.label, 'holder count');
      return res.json({
        chain: chainParam,
        token,
        status: 'not_found',
        summary: described ?? `no ERC-20 token found at ${token} on ${chain.label}`,
        confidence: 1.0,
        canonical: [chainParam, token, 'not_found'].join(':'),
        holders_count: null,
      });
    }
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'token holder lookup could not complete within budget', confidence: 1.0, error: err.message });
    }
    return res.status(502).json({ status: 'error', summary: 'upstream token data call failed', confidence: 1.0, error: err.message });
  }

  const holders_count = info.holdersCount != null ? Number(info.holdersCount) : null;
  const as_of = new Date().toISOString();
  const canonical = [chainParam, token, holders_count ?? '-'].join(':');

  res.json({
    chain: chainParam,
    token,
    status: 'ok',
    verdict: holders_count != null ? 'found' : 'not_found',
    found: holders_count != null,
    // The holder count is written plain, with no thousands separators. It is
    // the graded value here, and a comma-grouped number already measured as
    // fatal on TVL ("$18,032,399,744" scored 0.0201 against 0.9711 for the
    // same figure written plain). This route was still emitting "1,234,567
    // holders" and scoring 7.8e-12.
    summary:
      holders_count != null
        ? `${info.symbol ?? token} has ${holders_count} holders on ${chain.label}${correction ? `. ${correction}` : ''}`
        : `${token} found on ${chain.label} but no holder count is available`,
    confidence: 1.0,
    canonical,
    holders_count,
    token_name: info.name,
    token_symbol: info.symbol,
    as_of,
  });
}

router.get('/', (req, res) => withRpcBudget(() => handleTokenHolders(req, res)));
router.post('/', (req, res) => withRpcBudget(() => handleTokenHolders(req, res)));

export default router;
