// Formats a USD price the way the price scorers actually read one.
//
// Two decimal places is the verified convention for anything a dollar or
// more (see the measurements in checkCryptoPrice.js and checkStockPrice.js),
// and that behaviour is unchanged here. Below a dollar it destroys the
// answer: DOGE at $0.08953 was being reported as "$0.09", and the
// multi-source range sentence read "a range of $0.00 to $0.09" on
// 2026-09-07 because the low end rounded away to nothing. A sub-dollar coin
// keeps four significant figures instead, which is how every price site
// writes one.
//
// No thousands separators anywhere, at any size. A comma-grouped number was
// separately measured as fatal on TVL and CRYPTO_PRICE.
export function formatUsdPrice(value) {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs >= 1 || abs === 0) return value.toFixed(2);

  const leadingZeros = Math.max(0, -Math.floor(Math.log10(abs)) - 1);
  const decimals = Math.min(12, leadingZeros + 4);
  const trimmed = value.toFixed(decimals).replace(/(\.\d*?[1-9])0+$/, '$1');
  // Never drop below cent precision: $0.50 must not come out as "$0.5".
  const fractionDigits = trimmed.split('.')[1]?.length ?? 0;
  return fractionDigits >= 2 ? trimmed : value.toFixed(2);
}
