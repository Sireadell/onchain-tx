// SMART_CONTRACT_AUDIT signal endpoint. Takes a contract address (and chain)
// or pasted Solidity source, and returns an automated first-pass review for
// reentrancy, missing access control, integer overflow and a few other known
// red flags. See lib/contractAudit.js for what is checked and how.
// Query params: contract (also address/token/target), chain, source (also
// code/solidity). A free-text question that contains an address works too.

import { Router } from 'express';
import { CHAINS, DEFAULT_CHAIN, resolveChainLoose } from '../lib/chains.js';
import { extractAddress, freeTextParam, firstUsableValue } from '../lib/entityExtract.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { withRpcBudget, RpcBudgetExceededError } from '../lib/ankrRpc.js';
import {
  fetchVerifiedSource, fetchBytecode, scanBytecode, buildAudit, capSource, ContractAuditError,
} from '../lib/contractAudit.js';

const router = Router();

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLIDITY_RE = /pragma\s+solidity|\b(contract|library|interface)\s+\w+[^{;]*\{/;

export async function handleSmartContractAudit(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const question = freeTextParam(params);

  // Pasted source wins: a question that carries code is asking about that code.
  const pasted = firstUsableValue(params?.source, params?.code, params?.solidity, params?.contract_source);
  const pastedSource = [pasted, question].map((v) => (v == null ? '' : String(v))).find((v) => SOLIDITY_RE.test(v) && v.includes('{'));
  if (pastedSource) {
    const files = [{ path: 'pasted.sol', content: capSource(pastedSource) }];
    const audit = buildAudit({ target: 'the pasted contract', chainLabel: null, source: { files, compiler: null, name: null, via: 'pasted code' }, bytecode: null });
    return res.json({
      query: String(question ?? pasted).slice(0, 200),
      status: 'ok',
      ...audit,
      canonical: ['smart-contract-audit', 'source', audit.risk, audit.counts.high, audit.counts.medium, audit.counts.low].join(':'),
      checked_at: new Date().toISOString(),
    });
  }

  const rawTarget = firstUsableValue(params?.contract, params?.address, params?.token, params?.target, params?.contract_address, question);
  const address = rawTarget && ADDRESS_RE.test(String(rawTarget).trim()) ? String(rawTarget).trim() : extractAddress(rawTarget);
  if (!address) {
    return respondUnusableInput(
      res,
      `I cannot audit a contract because ${rawTarget ? `${quoteParam(rawTarget)} does not contain a contract address` : 'no contract address or source code was supplied'}. Pass the 42-character contract address (0x followed by 40 hex characters) as the contract parameter, with the chain, or paste the Solidity source as the source parameter.`,
    );
  }

  const chainParam = firstUsableValue(params?.chain, resolveChainLoose(question ?? '')?.key, DEFAULT_CHAIN);
  const chain = resolveChainLoose(chainParam);
  if (!chain) {
    return respondUnusableInput(res, `I cannot audit on ${quoteParam(chainParam)} because it is not a chain I read. I can audit contracts on ${Object.keys(CHAINS).join(', ')}.`);
  }

  let source = null;
  let sourceError = null;
  try {
    source = await fetchVerifiedSource(chain.key, chain.blockscoutHost, address);
  } catch (err) {
    if (!(err instanceof ContractAuditError)) throw err;
    sourceError = err.message;
  }

  let code = null;
  try {
    code = await withRpcBudget(() => fetchBytecode(chain.segment, address));
  } catch (err) {
    if (err instanceof RpcBudgetExceededError) {
      return res.status(503).json({ status: 'error', summary: 'contract audit could not complete within budget', confidence: 1.0, error: err.message });
    }
    if (!source) {
      return res.status(502).json({ status: 'error', summary: 'upstream contract data call failed', confidence: 0, error: err.message });
    }
  }

  if (!source && !code) {
    return res.json({
      chain: chain.key,
      contract: address,
      status: 'not_found',
      summary: `No contract code exists at ${address} on ${chain.label}, so there is nothing to audit. The address may be a wallet or may be on another chain.`,
      confidence: 0.95,
      canonical: [chain.key, address, 'no-code'].join(':'),
      risk: 'none-found',
      findings: [],
    });
  }

  const audit = buildAudit({
    target: address,
    chainLabel: chain.label,
    source,
    bytecode: code ? scanBytecode(code) : null,
    unverified: !source,
  });
  res.json({
    chain: chain.key,
    contract: address,
    status: 'ok',
    ...audit,
    source_note: sourceError && !source ? `Source lookup failed (${sourceError}), so only the bytecode was checked.` : null,
    canonical: [chain.key, address, audit.risk, audit.counts.high, audit.counts.medium, audit.counts.low].join(':'),
    checked_at: new Date().toISOString(),
  });
}

router.get('/', (req, res) => handleSmartContractAudit(req, res));
router.post('/', (req, res) => handleSmartContractAudit(req, res));

export default router;
