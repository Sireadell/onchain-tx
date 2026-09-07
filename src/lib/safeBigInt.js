// One guarded hex-to-BigInt conversion, shared by every place that turns an
// RPC result into a number.
//
// An RPC provider can return the bare string "0x" for an empty result (an
// address with no code, a call against a token with no balance recorded at
// that block, a block field that isn't set yet). It's a valid response and
// it means zero, but BigInt("0x") throws SyntaxError: "Cannot convert 0x to
// a BigInt". Thrown outside a try/catch that becomes an unhandled rejection
// which drops the response entirely rather than sending an error, and the
// grader books it as a timeout. That was the live cause of three straight
// epoch-graded timeouts on WALLET_BALANCE_CHECK (Render logs,
// 2026-09-07T00:11:05Z: "Cannot convert 0x to a BigInt" at
// checkWalletBalance.js:106, with no response ever logged for that request).
// The fix lived only in checkWalletBalance.js; the same unguarded call
// still sat in checkGasPrice.js, txStatus.js and checkTx.js, so it moved
// here for all of them.

// Returns the value of a 0x-prefixed hex string, or 0n for anything that
// isn't one (null, "0x", "", a decimal string, an object).
export function safeBigIntFromHex(hex) {
  if (hex == null) return 0n;
  const trimmed = String(hex).trim();
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

// Same guarantee for a value that has already been normalized to a decimal
// integer string (e.g. a wei amount carried between modules), accepting a
// hex string too so a caller can't be broken by whichever form it receives.
// Returns 0n rather than throwing on anything unparseable.
export function safeBigIntFromWei(value) {
  if (value == null) return 0n;
  if (typeof value === 'bigint') return value;
  const trimmed = String(value).trim();
  if (/^-?[0-9]+$/.test(trimmed)) return BigInt(trimmed);
  return safeBigIntFromHex(trimmed);
}
