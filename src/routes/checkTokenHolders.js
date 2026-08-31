// TOKEN_HOLDER_COUNT signal endpoint. No ground truth exists for this
// intent yet (checked live against /groundtruths/TOKEN_HOLDER_COUNT,
// 2026-08-18) — same speculative-on-grading caveat as the other two new
// endpoints. Uses Blockscout's REST API, not Ankr's JSON-RPC (Ankr has no
// direct holder-count method) — see blockscoutApi.js.

import { Router } from 'express';
import { getTokenInfo, TokenNotFoundError } from '../lib/blockscoutApi.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import { CHAINS, DEFAULT_CHAIN, resolveChainLoose } from '../lib/chains.js';
import { quoteParam, respondUnusableInput } from '../lib/unusableInput.js';
import { extractAddress, freeTextParam } from '../lib/entityExtract.js';
import { describeAddressMiss } from '../lib/addressContext.js';

const router = Router();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

async function handleTokenHolders(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  // Same free-text fallback as the other on-chain routes: the engine
  // sends "how many holders does 0xabc... have on Base" as a question, not
  // as a bare token param.
  const question = freeTextParam(params);
  const rawToken = params?.token ?? question;
  // Exact match first; if that fails, pull a contract address out of
  // whatever was sent instead of rejecting outright — this does not (and
  // cannot reliably) resolve a ticker like "USDC" to an address, only an
  // address already present but wrapped in other text. See
  // entityExtract.js.
  const token = rawToken && ADDRESS_RE.test(rawToken) ? rawToken : extractAddress(rawToken);
  const chainParam = params?.chain ?? resolveChainLoose(question ?? '')?.key ?? DEFAULT_CHAIN;

  if (!token) {
    const problem = rawToken
      ? `${quoteParam(rawToken)} does not contain a valid token contract address`
      : 'no token contract address was supplied';
    return respondUnusableInput(
      res,
      `I cannot count holders because ${problem}. I need the token's contract address, which is 42 characters long: "0x" followed by 40 hexadecimal characters. A token name or ticker will not work here. Pass the contract address as the token parameter and I will return its holder count.`,
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
  try {
    info = await getTokenInfo(chain.blockscoutHost, token);
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
    summary:
      holders_count != null
        ? `${info.symbol ?? token} has ${holders_count.toLocaleString('en-US')} holders on ${chain.label}`
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
