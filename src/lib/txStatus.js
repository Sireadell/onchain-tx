// Turns (tx, receipt, currentBlockNumber) into the three signal_mapping
// fields (status/summary/confidence) plus the structured fields, per
// BUILD_SPEC.md Confidence Semantics. Pure function, no I/O — kept separate
// from the route/RPC layer so the decision table itself is unit-testable
// without a network call.

const CONFIRMATION_DEPTH = Number(process.env.CONFIRMATION_DEPTH) || 12;

function hexToBigInt(hex) {
  return BigInt(hex);
}

export function evaluateTransaction({ tx, receipt, currentBlockNumberHex }) {
  if (!tx) {
    return {
      status: 'not_found',
      summary: 'no transaction with this hash was found on this chain',
      confidence: 1.0,
      from: null,
      to: null,
      value_wei: null,
      block_number: null,
    };
  }

  const from = tx.from ?? null;
  const to = tx.to ?? null; // null natively for contract creation
  const value_wei = tx.value != null ? hexToBigInt(tx.value).toString() : null;

  if (!receipt || tx.blockNumber == null) {
    return {
      status: 'pending',
      summary: 'transaction found but not yet mined — no receipt available',
      confidence: 0.3,
      from,
      to,
      value_wei,
      block_number: null,
    };
  }

  const block_number = Number(hexToBigInt(tx.blockNumber));
  const reverted = receipt.status === '0x0';

  if (reverted) {
    return {
      status: 'reverted',
      summary: 'transaction was mined but execution reverted',
      confidence: confidenceForDepth(block_number, currentBlockNumberHex),
      from,
      to,
      value_wei,
      block_number,
    };
  }

  const confidence = confidenceForDepth(block_number, currentBlockNumberHex);
  const depth = currentBlockNumberHex != null ? Number(hexToBigInt(currentBlockNumberHex)) - block_number : null;
  const shallow = depth !== null && depth < CONFIRMATION_DEPTH;

  return {
    status: 'confirmed',
    summary: shallow
      ? `transaction confirmed ${depth} block(s) deep — recent, not yet past the ${CONFIRMATION_DEPTH}-block confirmation depth`
      : 'transaction confirmed and succeeded',
    confidence,
    from,
    to,
    value_wei,
    block_number,
  };
}

function confidenceForDepth(txBlockNumber, currentBlockNumberHex) {
  if (currentBlockNumberHex == null) return 0.8; // couldn't fetch current height — still confirmed, just can't score depth
  const depth = Number(hexToBigInt(currentBlockNumberHex)) - txBlockNumber;
  if (depth < 0) return 0.8; // shouldn't happen, but don't claim more certainty than the data supports
  if (depth >= CONFIRMATION_DEPTH) return 1.0;
  // Linear ramp from 0.6 (just mined) to just-under-1.0 as depth approaches the threshold.
  return 0.6 + (0.4 * depth) / CONFIRMATION_DEPTH;
}
