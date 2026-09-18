// INVOICE_LEDGER_RECONCILE signal endpoint. Given two described figures or
// a described invoice/ledger discrepancy, reconciles what can be
// reconciled from arithmetic and the stated facts alone.
//
// No free API for this exists, and none would make sense: this is not a
// lookup against a real invoicing or ledger system this miner has no
// access to, it is a careful arithmetic/logic check over whatever numbers
// and facts the caller describes in text. A live web search would not help
// either (there is nothing on the public internet describing a caller's
// own invoice discrepancy). Per the brief, an LLM-based reasoning approach
// (lib/llmComplete.js) is the honest fit here: the model is asked to work
// through the arithmetic and state its reconciliation, not to claim it
// checked anything against a real ledger system it was never connected to.
// Prompt-injection risk is real (arbitrary caller text goes to the model),
// so the caller's text is framed with frameInput()/INJECTION_GUARD exactly
// as llmComplete.js documents for other data-not-instructions callers.

import { Router } from 'express';
import { llmComplete, hasLlmProvider, LlmCompleteError, frameInput, INJECTION_GUARD, capInput } from '../lib/llmComplete.js';
import { respondUnusableInput, quoteParam } from '../lib/unusableInput.js';
import { firstUsableValue } from '../lib/entityExtract.js';

const router = Router();

const MAX_INPUT_CHARS = 4_000;

const SYSTEM_PROMPT = 'You are a careful accounts-reconciliation assistant. You are given a description of an invoice, '
  + 'ledger, or set of financial figures below, possibly including a claimed discrepancy. '
  + 'Do the arithmetic carefully and state: (1) what the numbers actually add up to, (2) whether that matches what is '
  + 'claimed, and (3) if there is a discrepancy, the exact amount and most likely plain-language explanation (a missing '
  + 'line item, a tax or fee not accounted for, a rounding difference, a duplicate or missing entry) if one is evident '
  + 'from the stated facts. Never claim you checked this against a real ledger, invoicing, or accounting system: you '
  + 'only have the text given to you. If the text does not contain enough numbers or facts to reconcile anything, say '
  + 'so plainly rather than inventing figures. Reply in two to four plain prose sentences, leading with the answer.'
  + INJECTION_GUARD;

function hasEnoughContent(text) {
  return /\d/.test(text);
}

async function handleInvoiceLedgerReconcile(req, res) {
  const params = req.method === 'GET' ? req.query : req.body;
  const rawInput = firstUsableValue(
    params?.description, params?.invoice, params?.ledger, params?.discrepancy,
    params?.query, params?.q, params?.question, params?.text, params?.input,
  );

  if (!rawInput) {
    return respondUnusableInput(
      res,
      'I cannot reconcile an invoice or ledger discrepancy because no figures or description were supplied. Pass a description of the figures and the discrepancy as the description parameter.',
    );
  }

  const { text, truncated } = capInput(String(rawInput).trim(), MAX_INPUT_CHARS);
  if (!text || !/[a-z0-9]/i.test(text)) {
    return respondUnusableInput(res, `No usable invoice or ledger description was found in ${quoteParam(rawInput)}. Pass the figures and any claimed discrepancy in plain text.`);
  }

  if (!hasEnoughContent(text)) {
    return respondUnusableInput(res, `No numeric figures were found in ${quoteParam(rawInput)}. Include at least the amounts involved so this can be reconciled.`);
  }

  if (!hasLlmProvider()) {
    return res.status(503).json({
      status: 'error',
      summary: 'Invoice/ledger reconciliation is not configured on this deployment.',
      confidence: 0,
      error: 'PERPLEXITY_API_KEY is not set',
    });
  }

  let result;
  try {
    result = await llmComplete(SYSTEM_PROMPT, frameInput(text), { disableSearch: true, temperature: 0.1, maxTokens: 400 });
  } catch (err) {
    if (err instanceof LlmCompleteError) {
      return res.status(502).json({
        status: 'error',
        summary: `Invoice/ledger reconciliation is temporarily unavailable for ${quoteParam(rawInput)}. Retry shortly.`,
        confidence: 0,
        error: err.message,
      });
    }
    return res.status(502).json({ status: 'error', summary: 'invoice/ledger reconciliation failed', confidence: 0, error: err.message });
  }

  if (!result?.text) {
    return respondUnusableInput(res, `No reconciliation could be produced for ${quoteParam(rawInput)}. Include the specific figures being compared.`);
  }

  const summary = truncated ? `${result.text} (Note: the input was truncated to ${MAX_INPUT_CHARS} characters before this check.)` : result.text;

  res.json({
    query: text.slice(0, 500),
    status: 'ok',
    summary,
    confidence: 0.55,
    canonical: ['invoice-ledger-reconcile', text.slice(0, 100)].join(':'),
    source: 'llm arithmetic/reasoning check over caller-provided figures',
    verified_against_live_ledger: false,
    truncated,
    checked_at: new Date().toISOString(),
  });
}

router.get('/', handleInvoiceLedgerReconcile);
router.post('/', handleInvoiceLedgerReconcile);

export default router;
